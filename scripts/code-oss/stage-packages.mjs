// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// Stages packages/* into a Code OSS tree (ADR 0005 D3). Run by the post-apply hook
// code-oss/hooks/post-apply.d/20-stage-axis-packages.
//
//   node scripts/code-oss/stage-packages.mjs --tree <code-oss tree> [--repo <axis root>] [--verify]
//
// Output, all new files under <tree>/src/vs/axis/packages/:
//   <name>/**           the package's src/**/*.ts (tests excluded), imports rewritten to relative paths,
//                       plus a generated-file header;
//   vendor/zod/**       the ESM JavaScript and declarations of zod reachable from its entry point, copied
//                       from the repository's node_modules;
//   stage-manifest.json sha-256 of every staged file and of its source, and the tree hash.
//
// Why zod is vendored: build/next bundles with esbuild `packages: 'external'`, so a bare `zod` import stays an
// import and resolves at run time to the application's own node_modules (4.4.3 at the pinned upstream commit).
// Rewriting it to the vendored copy puts zod 4.6.6 inside the bundle.
//
// Allowlist (anything else fails the run, and a failed run leaves no staged output):
//   - inputs are regular files under packages/<name>/src/**/*.ts and the zod files its entry reaches;
//     links, devices, hidden names, node_modules, dist, .d.ts, tests and every other extension are refused;
//   - nothing is read through a link (O_NOFOLLOW) and nothing is written through one;
//   - a source file modified while staging, or dated in the future, is refused;
//   - the staged output is re-read from disk and checked again (scripts/code-oss/stage-verify.mjs).
// Deterministic: output depends on file contents only (no time, user, umask or path), so the same input gives
// the same tree hash. Idempotent: the output directory is deleted and rebuilt.
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FORBIDDEN_DIRS,
  NAME_RE,
  StageError,
  assertRealDirChain,
  fail,
  listDir,
  readRegular,
  unchanged,
  walkFiles,
} from "./stage-fs.mjs";
import {
  classifySpecifier,
  hiddenLoaders,
  importSpecifiers,
  nonLiteralLoads,
  rewriteSpecifiers,
} from "./stage-scan.mjs";
import { MANIFEST_NAME, MAX_FILE_BYTES, STAGE_ROOT, checkStagedFile, sha256, treeHash, verifyStaged } from "./stage-verify.mjs";

export { STAGE_ROOT };
export { importSpecifiers, nonLiteralLoads, rewriteSpecifiers } from "./stage-scan.mjs";

const GENERATED = "Staged by code-oss/hooks/post-apply.d/20-stage-axis-packages. Do not edit; edit the source and rerun apply.sh.";
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const DEFAULT_FUTURE_SKEW_MS = 5 * 60 * 1000;
const PACKAGE_DIR_RE = /^[a-z][a-z0-9-]*$/;

const decode = (data, what) => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    if (text.includes("\0")) fail(`${what}: contains a NUL byte`);
    return text;
  } catch (e) {
    if (e instanceof StageError) throw e;
    return fail(`${what}: not valid UTF-8 text`);
  }
};

/** Files of zod reachable from index.js by relative imports, plus their .d.ts twins, package.json and the licence. */
export function zodClosure(zodDir, read = (rel) => readRegular(join(zodDir, rel), MAX_FILE_BYTES).data) {
  const wanted = new Set(["package.json", "LICENSE"]);
  const queue = ["index.js"];
  const exists = (rel) => {
    try {
      read(rel);
      return true;
    } catch (e) {
      if (e instanceof StageError || e.code === "ENOENT") return false;
      throw e;
    }
  };
  while (queue.length > 0) {
    const f = queue.pop();
    if (wanted.has(f)) continue;
    if (f.startsWith("../") || f === ".." || posix.isAbsolute(f)) fail(`zod file import leaves the package: ${f}`);
    wanted.add(f);
    const dts = f.replace(/\.js$/, ".d.ts");
    if (dts !== f && exists(dts)) {
      wanted.add(dts);
      for (const spec of importSpecifiers(decode(read(dts), dts), { code: true })) {
        if (spec.startsWith(".")) queue.push(posix.normalize(posix.join(posix.dirname(dts), spec)).replace(/\.d\.ts$/, ".js"));
      }
    }
    for (const spec of importSpecifiers(decode(read(f), f), { code: true })) {
      if (!spec.startsWith(".")) fail(`zod file ${f} imports a bare specifier: ${spec}`);
      queue.push(posix.normalize(posix.join(posix.dirname(f), spec)));
    }
  }
  return [...wanted].filter(exists).sort();
}

/** Subpaths a package exports that map to a staged src file: `{ ".": "index", "./daemon-principal": "daemon-principal" }`. */
function stageableExports(name, pkgJson, srcFiles) {
  const out = {};
  for (const [key, val] of Object.entries(pkgJson.exports ?? {})) {
    const target = typeof val === "string" ? val : val?.default;
    const m = /^\.\/dist\/src\/([A-Za-z0-9_][A-Za-z0-9._/-]*)\.js$/.exec(target ?? "");
    if (m && srcFiles.has(`${m[1]}.ts`)) out[key] = m[1];
  }
  if (out["."] !== "index") fail(`packages/${name}: package.json exports "." must be ./dist/src/index.js`);
  return out;
}

/** The staged directory, if present, must be ours: a real directory holding a manifest and only files it lists. */
function checkExistingOutput(tree, stageRoot) {
  assertRealDirChain(tree, STAGE_ROOT.split("/"));
  if (!existsSync(stageRoot)) return;
  let manifest;
  try {
    manifest = JSON.parse(readRegular(join(stageRoot, MANIFEST_NAME), MAX_FILE_BYTES).data.toString("utf8"));
  } catch {
    fail(`${STAGE_ROOT} exists in the tree and was not staged by this script (overlay or patch collision)`);
  }
  const listed = new Set((manifest?.files ?? []).map((f) => f.path));
  for (const f of walkFiles(stageRoot)) {
    if (f.rel !== MANIFEST_NAME && !listed.has(f.rel)) fail(`${STAGE_ROOT}/${f.rel}: unexpected file in the staged directory (not in its manifest)`);
  }
}

export function stage({ repo, tree, now = Date.now(), maxFutureSkewMs = DEFAULT_FUTURE_SKEW_MS, beforeRecheck = undefined }) {
  const packagesDir = join(repo, "packages");
  const stageRoot = join(tree, STAGE_ROOT);
  checkExistingOutput(tree, stageRoot);
  rmSync(stageRoot, { recursive: true, force: true });

  const sigs = new Map();
  let total = 0;
  const read = (path) => {
    const { data, sig } = readRegular(path, MAX_FILE_BYTES);
    total += data.length;
    if (total > MAX_TOTAL_BYTES) fail(`inputs exceed ${MAX_TOTAL_BYTES} bytes`);
    sigs.set(path, sig);
    return data;
  };
  const mtimeOk = (path) => {
    const t = Number(sigs.get(path).split(":")[1]);
    if (t > now + maxFutureSkewMs) fail(`${path}: modified in the future (clock skew or tampering)`);
  };

  const names = [];
  for (const e of listDir(packagesDir)) {
    if (!e.dir) continue; // files beside the packages are not staged
    if (!PACKAGE_DIR_RE.test(e.name)) fail(`packages/${e.name}: not a valid package directory name`);
    names.push(e.name);
  }
  if (names.length === 0) fail("no packages to stage");

  // Manifests and the zod pin.
  const pkgJson = {};
  const zodVersions = new Set();
  for (const n of names) {
    const p = join(packagesDir, n, "package.json");
    const json = JSON.parse(decode(read(p), p));
    mtimeOk(p);
    if (json.name !== `@axis/${n}`) fail(`packages/${n}/package.json: name is ${json.name}, expected @axis/${n}`);
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const dep of Object.keys(json[field] ?? {})) {
        if (dep !== "zod" && !dep.startsWith("@axis/")) fail(`packages/${n}/package.json: ${field}.${dep} is outside the allowlist`);
      }
    }
    pkgJson[n] = json;
    if (json.dependencies?.zod !== undefined) zodVersions.add(json.dependencies.zod);
  }
  if (zodVersions.size > 1) fail(`packages pin different zod versions: ${[...zodVersions].join(", ")}`);
  const zodPinned = [...zodVersions][0];
  const zodDir = join(repo, "node_modules", "zod");
  if (!existsSync(zodDir)) fail("node_modules/zod is missing; run `npm ci --ignore-scripts` at the repository root");
  assertRealDirChain(repo, ["node_modules", "zod"]);
  const zodMeta = JSON.parse(decode(read(join(zodDir, "package.json")), "zod/package.json"));
  if (zodMeta.name !== "zod") fail(`node_modules/zod/package.json names ${zodMeta.name}, not zod`);
  if (zodPinned !== undefined && zodMeta.version !== zodPinned) {
    fail(`installed zod is ${zodMeta.version} but packages pin ${zodPinned}; run \`npm ci --ignore-scripts\``);
  }

  // Plan every output in memory first; nothing is written until all checks pass.
  const plan = new Map(); // staged path -> { content: string|Buffer, source, sourceSha256 }
  if (zodPinned !== undefined) {
    for (const f of zodClosure(zodDir, (rel) => (rel === "package.json" ? read(join(zodDir, rel)) : readRegular(join(zodDir, rel), MAX_FILE_BYTES).data))) {
      const p = join(zodDir, f);
      const data = read(p);
      mtimeOk(p);
      plan.set(`vendor/zod/${f}`, { content: data, source: `node_modules/zod/${f}`, sourceSha256: sha256(data) });
    }
  }

  const sources = {}; // name -> Map(srcRel -> { abs, text })
  for (const n of names) {
    const srcDir = join(packagesDir, n, "src");
    assertRealDirChain(packagesDir, [n, "src"]);
    const files = new Map();
    for (const f of walkFiles(srcDir)) {
      const parts = f.rel.split("/");
      for (const part of parts) {
        if (!NAME_RE.test(part)) fail(`packages/${n}/src/${f.rel}: name is outside the allowlist`);
      }
      if (parts.slice(0, -1).some((d) => FORBIDDEN_DIRS.has(d))) fail(`packages/${n}/src/${f.rel}: node_modules and dist are never staged`);
      if (!f.rel.endsWith(".ts") || f.rel.endsWith(".d.ts")) fail(`packages/${n}/src/${f.rel}: only .ts sources are staged (no .d.ts, .js, .json or binaries)`);
      if (/\.(?:test|spec)\.ts$/.test(f.rel)) fail(`packages/${n}/src/${f.rel}: tests belong in test/, outside the staged tree`);
      const data = read(f.path);
      mtimeOk(f.path);
      files.set(f.rel, { abs: f.path, data, text: decode(data, `packages/${n}/src/${f.rel}`) });
    }
    if (!files.has("index.ts")) fail(`packages/${n}/src/index.ts is missing`);
    sources[n] = files;
  }
  const exportMaps = Object.fromEntries(names.map((n) => [n, stageableExports(n, pkgJson[n], sources[n])]));
  const exportsOf = (n) => (names.includes(n) ? Object.keys(exportMaps[n]) : null);

  for (const n of names) {
    for (const [rel, { abs, data, text }] of sources[n]) {
      const sourceRel = `packages/${n}/src/${rel}`;
      for (const t of hiddenLoaders(text)) fail(`${sourceRel}: ${t} hides a load from the import check`);
      for (const t of nonLiteralLoads(text)) fail(`${sourceRel}: dynamic load needs a string literal (${t})`);
      for (const spec of importSpecifiers(text)) {
        let c;
        try {
          c = classifySpecifier(spec, n, exportsOf);
        } catch (reason) {
          if (typeof reason !== "string") throw reason;
          return fail(`${sourceRel}: ${reason}`);
        }
        if (c.kind === "relative") {
          const target = relative(join(packagesDir, n, "src"), resolve(dirname(abs), spec)).split("\\").join("/");
          if (target.startsWith("..")) fail(`${sourceRel}: relative import ${spec} leaves the package's src`);
          if (!target.endsWith(".js") || !sources[n].has(target.replace(/\.js$/, ".ts"))) {
            fail(`${sourceRel}: relative import ${spec} must name a staged .ts source with a .js suffix`);
          }
        }
      }
      const fromFile = `${STAGE_ROOT}/${n}/${rel}`;
      const rewritten = rewriteSpecifiers(text, fromFile, (spec) => {
        if (spec === "zod") return `${STAGE_ROOT}/vendor/zod/index.js`;
        const m = /^@axis\/([^/]+)(?:\/(.+))?$/.exec(spec);
        if (!m) return null;
        const mapped = exportMaps[m[1]][m[2] === undefined ? "." : `./${m[2]}`];
        return `${STAGE_ROOT}/${m[1]}/${mapped}.js`;
      });
      const lines = rewritten.split("\n");
      const head = lines[0]?.startsWith("// Copyright") ? [lines.shift()] : []; // copyright line first, then the notice
      plan.set(`${n}/${rel}`, { content: [...head, `// ${GENERATED}`, ...lines].join("\n"), source: sourceRel, sourceSha256: sha256(data) });
    }
  }

  // The import allowlist on the OUTPUT, before anything is written.
  const fileSet = new Set(plan.keys());
  for (const [path, { content }] of plan) {
    if (/\.(?:ts|js)$/.test(path)) checkStagedFile(path, content.toString(), fileSet);
  }

  // No input may have changed while it was being staged. (`beforeRecheck` is a test seam.)
  beforeRecheck?.();
  for (const [path, sig] of sigs) if (!unchanged(path, sig)) fail(`${path}: changed while staging`);

  const dirs = new Set();
  const files = [];
  for (const [path, { content, source, sourceSha256 }] of [...plan].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const dest = join(stageRoot, path);
    for (let d = dirname(dest); d.length > tree.length; d = dirname(d)) dirs.add(d);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content, { flag: "wx", mode: 0o644 });
    chmodSync(dest, 0o644);
    files.push({ path, sha256: sha256(content), source, sourceSha256 });
  }
  const manifest = { schema: 1, zod: zodPinned ?? null, packages: names, treeSha256: treeHash(files), files };
  const manifestPath = join(stageRoot, MANIFEST_NAME);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  chmodSync(manifestPath, 0o644);
  for (const d of dirs) if (d.startsWith(stageRoot)) chmodSync(d, 0o755);

  try {
    verifyStaged(tree);
  } catch (e) {
    rmSync(stageRoot, { recursive: true, force: true });
    throw e;
  }
  return manifest;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const repo = resolve(get("--repo") ?? join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const tree = get("--tree") ?? process.env.AXIS_CODE_OSS_TREE;
  if (!tree) {
    console.error("usage: stage-packages.mjs --tree <code-oss tree> [--repo <axis root>] [--verify]");
    process.exit(2);
  }
  try {
    if (args.includes("--verify")) {
      const m = verifyStaged(resolve(tree));
      console.log(`verified ${m.files.length} staged file(s); tree ${m.treeSha256}`);
    } else {
      const m = stage({ repo, tree: resolve(tree) });
      console.log(`staged ${m.files.length} file(s) from ${m.packages.length} package(s); zod ${m.zod}; tree ${m.treeSha256}`);
    }
  } catch (e) {
    if (!(e instanceof StageError)) throw e;
    console.error(`stage-axis-packages: ${e.message}`);
    process.exit(1);
  }
}
