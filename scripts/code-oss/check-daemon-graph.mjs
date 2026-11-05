// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// Bundle-time module-graph check for the staged Axis packages (ADR 0005 D3 and D4).
//
//   node scripts/code-oss/check-daemon-graph.mjs --tree <code-oss tree> [--all-packages] [--entry <tree-relative .ts>]...
//
// Limits: this bundles with esbuild platform `node`; build/next uses `neutral` plus plugins. The resolved graph was
// identical in the review run (232 inputs, same externals), but it does NOT model build/next's post-processing
// (NLS, `--mangle-privates`): see check-privates.mjs and ADR 0005 D3.6.
//
// Bundles the daemon entry (and, with --all-packages, every staged package index) with Code OSS's own esbuild and
// the options of build/next/bundle.ts, with a metafile, then checks what esbuild really resolved. It does not depend
// on how an import is spelled, but it sees only static edges esbuild can resolve: a computed `import(x)` is invisible
// to it, which is why the parse-based source check (stage-ast.mjs) refuses those:
//   1. every input under src/vs/axis/packages is a file the staging hook wrote (listed in its manifest);
//   2. no input comes from node_modules (so zod is the vendored 4.6.6, never the tree's own copy);
//   3. a staged module imports only `node:*` externals and other staged modules (an import that esbuild dropped as
//      unused is reported as external with its relative specifier; that is accepted only if it names a staged file);
//      any other external import (a bare `zod`, `vs/*`, `electron`) would resolve from the tree at run time and is refused;
//   4. a restricted module (the user principal, the trust attestation; RESTRICTED_MODULES) is imported only by its
//      own package and by the packages allowed to (the daemon), never by the overlay entry or any other package;
//   5. the bundled text carries the pinned zod version and not the tree's.
import { createRequire } from "node:module";
import { join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RESTRICTED_MODULES } from "./stage-scan.mjs";
import { MANIFEST_NAME, STAGE_ROOT, verifyStaged } from "./stage-verify.mjs";
import { readFileSync } from "node:fs";

export const DEFAULT_ENTRY = "src/vs/axis/daemon/node/axisDaemonMain.ts";
const PREFIX = `${STAGE_ROOT}/`;

const versionPattern = (v) => {
  const [major, minor, patch] = v.split(".");
  return new RegExp(`major\\s*:\\s*${major}\\s*,\\s*minor\\s*:\\s*${minor}\\s*,\\s*patch\\s*:\\s*${patch}\\b`);
};

/**
 * Pure check of an esbuild metafile. `manifest` is the staging manifest, `bundledText` the concatenated output
 * (optional) and `treeZod` the version of the tree's own zod (optional). Returns the list of violations.
 */
export function checkMetafile(metafile, manifest, { bundledText = null, treeZod = null } = {}) {
  const bad = [];
  const staged = new Set(manifest.files.map((f) => f.path));
  const stagedOf = (p) => (p.startsWith(PREFIX) ? p.slice(PREFIX.length) : null);
  const pkgOf = (rel) => rel.split("/")[0];
  for (const [input, info] of Object.entries(metafile.inputs)) {
    if (/(^|\/)node_modules\//.test(input)) bad.push(`${input}: comes from node_modules (resolved from the tree, not vendored)`);
    const rel = stagedOf(input);
    for (const imp of info.imports) {
      const target = stagedOf(imp.path);
      for (const r of RESTRICTED_MODULES) {
        if (target !== `${r.pkg}/${r.file}`) continue;
        const importerPkg = rel === null ? null : pkgOf(rel);
        if (importerPkg !== r.pkg && !(importerPkg !== null && r.importers.has(importerPkg)) && r.files?.has(rel) !== true) {
          bad.push(`${input}: imports ${imp.path}, which only ${[r.pkg, ...r.importers].join(" and ")} may import`);
        }
      }
    }
    for (const imp of info.imports) {
      if (imp.external === true && (imp.path === "zod" || imp.path.startsWith("zod/"))) {
        bad.push(`${input}: imports bare "${imp.path}", which resolves to the tree's own copy at run time (use the staged @axis packages)`);
      }
    }
    if (rel === null) continue;
    if (rel !== MANIFEST_NAME && !staged.has(rel)) bad.push(`${input}: under ${STAGE_ROOT} but not written by the staging hook`);
    for (const imp of info.imports) {
      if (imp.external === true) {
        if (/^node:/.test(imp.path)) continue;
        // esbuild also flags an import it dropped (a type-only or unused TypeScript import) as external, with the
        // specifier as written. A relative one is harmless only if it names a staged file.
        const target = imp.path.startsWith("./") || imp.path.startsWith("../") ? posix.normalize(posix.join(posix.dirname(rel), imp.path)) : null;
        const names = target === null ? [] : [target, target.replace(/\.js$/, ".ts")];
        if (!names.some((n) => staged.has(n))) bad.push(`${input}: external import "${imp.path}" resolves from the tree at run time`);
      } else if (!imp.path.startsWith(PREFIX)) {
        bad.push(`${input}: reaches ${imp.path}, outside the staged tree`);
      }
    }
  }
  if (manifest.zod !== null && manifest.zod !== undefined && bundledText !== null) {
    const usesZod = Object.keys(metafile.inputs).some((i) => i.startsWith(`${PREFIX}vendor/zod/`));
    if (usesZod && !versionPattern(manifest.zod).test(bundledText)) bad.push(`bundle does not contain zod ${manifest.zod}`);
    if (treeZod !== null && treeZod !== manifest.zod && versionPattern(treeZod).test(bundledText)) bad.push(`bundle contains the tree's zod ${treeZod}`);
  }
  return bad;
}

/** Bundles `entries` (tree-relative) in `tree` with Code OSS's esbuild, then checks the metafile. */
export async function checkTree({ tree, entries }) {
  const manifest = verifyStaged(tree); // the hook's output must be intact before its graph means anything
  const req = createRequire(join(tree, "build", "package.json"));
  const esbuild = req("esbuild");
  const { getBundleOptions } = await import(pathToFileURL(join(tree, "build", "next", "bundle.ts")).href);
  const result = await esbuild.build({
    ...getBundleOptions(false, "node"),
    entryPoints: entries.map((e) => join(tree, e)),
    outdir: join(tree, "out-axis-graph"),
    absWorkingDir: tree,
    metafile: true,
    sourcemap: false,
    write: false,
  });
  const treeZod = JSON.parse(readFileSync(join(tree, "node_modules", "zod", "package.json"), "utf8")).version;
  const bundledText = result.outputFiles.map((f) => f.text).join("\n");
  const violations = checkMetafile(result.metafile, manifest, { bundledText, treeZod });
  const inputs = Object.keys(result.metafile.inputs);
  return {
    violations, manifest, entries, inputs: inputs.length, stagedInputs: inputs.filter((i) => i.startsWith(PREFIX)).length, zod: manifest.zod, treeZod };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const values = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  const tree = values("--tree")[0] ?? process.env.AXIS_CODE_OSS_TREE;
  if (!tree) {
    console.error("usage: check-daemon-graph.mjs --tree <code-oss tree> [--all-packages] [--entry <tree-relative .ts>]...");
    process.exit(2);
  }
  const root = resolve(tree);
  const entries = values("--entry");
  if (entries.length === 0) entries.push(DEFAULT_ENTRY);
  if (args.includes("--all-packages")) {
    const m = verifyStaged(root);
    for (const n of m.packages) entries.push(`${PREFIX}${n}/index.ts`);
  }
  try {
    const r = await checkTree({ tree: root, entries: [...new Set(entries.map((e) => posix.normalize(e)))] });
    console.log(`bundled ${r.entries.length} entr${r.entries.length === 1 ? "y" : "ies"}: ${r.inputs} inputs, ${r.stagedInputs} staged; zod ${r.zod} (tree has ${r.treeZod})`);
    if (r.violations.length > 0) {
      for (const v of r.violations) console.error(`check-daemon-graph: ${v}`);
      process.exit(1);
    }
    console.log("module graph ok");
  } catch (e) {
    console.error(`check-daemon-graph: ${e.message}`);
    process.exit(1);
  }
}
