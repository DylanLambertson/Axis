// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// Stages packages/* into a Code OSS tree (ADR 0005 D3). Run by the post-apply
// hook code-oss/hooks/post-apply.d/20-stage-axis-packages.
//
//   node scripts/code-oss/stage-packages.mjs --tree <code-oss tree> [--repo <axis root>]
//
// Output, all new files under <tree>/src/vs/axis/packages/:
//   <name>/**           the package's src/**/*.ts (tests excluded), with imports
//                       rewritten to relative paths, plus a generated-file header;
//   vendor/zod/**       the ESM JavaScript and declarations of zod reachable from
//                       its entry point, copied from the repository's node_modules;
//   stage-manifest.json sha-256 of every staged file and of its source.
//
// Why zod is vendored: build/next bundles with esbuild `packages: 'external'`,
// so a bare `zod` import stays an import and resolves at run time to the
// application's own node_modules (4.4.3 at the pinned upstream commit). Rewriting
// it to the vendored copy puts zod 4.6.6 inside the bundle.
//
// Deterministic and idempotent: the output directory is deleted and rebuilt, and
// nothing in it depends on time or the machine.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const STAGE_ROOT = "src/vs/axis/packages";
const GENERATED = "Staged by code-oss/hooks/post-apply.d/20-stage-axis-packages. Do not edit; edit the source and rerun apply.sh.";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Matches the specifier string in every import form. Group 1 is the text before it, 2 the specifier. */
const SPECIFIER_PATTERNS = [
  /(\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"])([^'"]+)(?=['"])/g,
  /(\bimport\s*['"])([^'"]+)(?=['"])/g,
  /(\bimport\s*\(\s*['"])([^'"]+)(?=['"])/g,
];

export function importSpecifiers(source) {
  const text = stripComments(source);
  const found = [];
  for (const re of SPECIFIER_PATTERNS) for (const m of text.matchAll(re)) found.push(m[2]);
  return found;
}

/** Dynamic loads whose argument is not a string literal cannot be rewritten, so they fail. */
export function nonLiteralLoads(source) {
  const text = stripComments(source);
  return [...text.matchAll(/\b(?:import|require)\s*\(\s*(?!['"][^'"`$]*['"]\s*\))/g)].map((m) => m[0]);
}

/**
 * Rewrites package specifiers to relative paths. `resolveSpec(spec)` returns the
 * absolute staged path to point at, or null to leave the specifier alone.
 */
export function rewriteSpecifiers(source, fromFile, resolveSpec) {
  let out = source;
  for (const re of SPECIFIER_PATTERNS) {
    out = out.replace(re, (whole, head, spec) => {
      const target = resolveSpec(spec);
      if (target === null) return whole;
      let rel = posix.relative(posix.dirname(fromFile), target);
      if (!rel.startsWith(".")) rel = `./${rel}`;
      return `${head}${rel}`;
    });
  }
  return out;
}

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

const toPosix = (p) => p.split(sep).join("/");

/** Files of zod reachable from index.js by relative imports, plus their .d.ts twins and the licence. */
export function zodClosure(zodDir) {
  const wanted = new Set(["package.json", "LICENSE"]);
  const queue = ["index.js"];
  while (queue.length > 0) {
    const f = queue.pop();
    if (wanted.has(f)) continue;
    wanted.add(f);
    const dts = f.replace(/\.js$/, ".d.ts");
    if (existsSync(join(zodDir, dts))) {
      wanted.add(dts);
      for (const spec of importSpecifiers(readFileSync(join(zodDir, dts), "utf8"))) {
        if (spec.startsWith(".")) queue.push(posix.normalize(posix.join(posix.dirname(dts), spec)).replace(/\.d\.ts$/, ".js"));
      }
    }
    for (const spec of importSpecifiers(readFileSync(join(zodDir, f), "utf8"))) {
      if (!spec.startsWith(".")) throw new Error(`zod file ${f} imports a bare specifier: ${spec}`);
      queue.push(posix.normalize(posix.join(posix.dirname(f), spec)));
    }
  }
  return [...wanted].filter((f) => existsSync(join(zodDir, f))).sort();
}

export function stage({ repo, tree }) {
  const packagesDir = join(repo, "packages");
  const stageRoot = join(tree, STAGE_ROOT);
  const manifestPath = join(stageRoot, "stage-manifest.json");
  if (existsSync(stageRoot) && !existsSync(manifestPath)) {
    throw new Error(`${STAGE_ROOT} exists in the tree and was not staged by this script (overlay or patch collision)`);
  }
  rmSync(stageRoot, { recursive: true, force: true });

  const names = readdirSync(packagesDir).filter((n) => statSync(join(packagesDir, n)).isDirectory()).sort();
  if (names.length === 0) throw new Error("no packages to stage");

  // Package versions of zod must agree, and must match the installed copy.
  const zodVersions = new Set();
  const pkgJson = {};
  for (const n of names) {
    pkgJson[n] = JSON.parse(readFileSync(join(packagesDir, n, "package.json"), "utf8"));
    const v = pkgJson[n].dependencies?.zod;
    if (v !== undefined) zodVersions.add(v);
  }
  if (zodVersions.size > 1) throw new Error(`packages pin different zod versions: ${[...zodVersions].join(", ")}`);
  const zodDir = join(repo, "node_modules", "zod");
  if (!existsSync(zodDir)) throw new Error("node_modules/zod is missing; run `npm ci --ignore-scripts` at the repository root");
  const zodInstalled = JSON.parse(readFileSync(join(zodDir, "package.json"), "utf8")).version;
  const zodPinned = [...zodVersions][0];
  if (zodPinned !== undefined && zodInstalled !== zodPinned) {
    throw new Error(`installed zod is ${zodInstalled} but packages pin ${zodPinned}; run \`npm ci --ignore-scripts\``);
  }

  const files = [];
  const write = (relPath, content, source) => {
    const dest = join(stageRoot, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
    files.push({ path: relPath, sha256: sha256(content), ...(source ? { source } : {}) });
  };

  // Vendored zod.
  if (zodPinned !== undefined) {
    for (const f of zodClosure(zodDir)) {
      write(`vendor/zod/${f}`, readFileSync(join(zodDir, f)), `node_modules/zod/${f}`);
    }
  }
  const vendorZodIndex = `${STAGE_ROOT}/vendor/zod/index.js`;

  // Package sources.
  for (const n of names) {
    const srcDir = join(packagesDir, n, "src");
    if (!existsSync(join(srcDir, "index.ts"))) throw new Error(`packages/${n}/src/index.ts is missing`);
    for (const abs of walk(srcDir)) {
      if (!abs.endsWith(".ts") || abs.endsWith(".d.ts")) continue;
      const rel = toPosix(relative(srcDir, abs));
      const sourceRel = `packages/${n}/src/${rel}`;
      const text = readFileSync(abs, "utf8");
      const bad = nonLiteralLoads(text);
      if (bad.length > 0) throw new Error(`${sourceRel}: dynamic load needs a string literal`);
      const fromFile = `${STAGE_ROOT}/${n}/${rel}`;
      for (const spec of importSpecifiers(text)) {
        if (spec.startsWith(".")) {
          const target = relative(join(packagesDir, n), resolve(dirname(abs), spec));
          if (target.startsWith("..")) throw new Error(`${sourceRel}: relative import ${spec} leaves the package`);
        } else if (spec === "zod" || spec.startsWith("zod/")) {
          if (spec !== "zod") throw new Error(`${sourceRel}: only the "zod" entry is staged, not ${spec}`);
        } else if (spec.startsWith("@axis/")) {
          const dep = spec.slice("@axis/".length);
          if (!names.includes(dep)) throw new Error(`${sourceRel}: unknown workspace package ${spec}`);
        } else if (!spec.startsWith("node:")) {
          throw new Error(`${sourceRel}: import ${spec} is outside the allowlist`);
        }
      }
      const rewritten = rewriteSpecifiers(text, fromFile, (spec) => {
        if (spec === "zod") return vendorZodIndex;
        if (spec.startsWith("@axis/")) return `${STAGE_ROOT}/${spec.slice(6)}/index.js`;
        return null;
      });
      const lines = rewritten.split("\n");
      // Keep a leading copyright line first, then the generated-file notice.
      const head = lines[0]?.startsWith("// Copyright") ? [lines.shift()] : [];
      write(`${n}/${rel}`, [...head, `// ${GENERATED}`, ...lines].join("\n"), sourceRel);
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest = { zod: zodPinned ?? null, packages: names, files };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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
    console.error("usage: stage-packages.mjs --tree <code-oss tree> [--repo <axis root>]");
    process.exit(2);
  }
  try {
    const m = stage({ repo, tree: resolve(tree) });
    console.log(`staged ${m.files.length} file(s) from ${m.packages.length} package(s); zod ${m.zod}`);
  } catch (e) {
    console.error(`stage-axis-packages: ${e.message}`);
    process.exit(1);
  }
}
