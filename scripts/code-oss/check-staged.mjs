// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
//
// Verifies the staged Axis packages inside an applied Code OSS tree (ADR 0005 D3 spike criteria 1, 2 and 6):
//
//   node scripts/code-oss/check-staged.mjs --tree <code-oss tree>
//
//   1. the staged output matches its manifest and passes the import allowlist (verifyStaged);
//   2. everything under src/vs/axis type-checks with the tree's own compiler and src/tsconfig.base.json flags
//      (a temporary src/tsconfig.axis-check.json, removed afterwards; skipLibCheck off, so the vendored zod
//      declarations are checked too);
//      With --full-typecheck it runs the tree's real `npm run typecheck-client` (`tsc --project src/tsconfig.json`,
//      about 1 minute and 8.5 GiB: run it under `flock ~/.cache/project-axis/build.lock`). Only that run sees the
//      tree's global typings (for example setTimeout returning an opaque handle), which the quick check does not.
//   3. the daemon entry and every staged package index bundle with the tree's esbuild, and the module graph is
//      clean (check-daemon-graph.mjs): zod 4.6.6 vendored, never the tree's copy; no restricted module leaks.
//   4. the tree's build/next/index.ts exempts vs/axis outputs from `#private` mangling (check-privates.mjs). With
//      --build-bundle it also runs the tree's real minified bundle step (about 6 minutes, 4 GiB: run it under
//      `flock ~/.cache/project-axis/build.lock`) and checks that the built daemon bundle still has the `#` fields
//      its staged sources declare.
// Needs the tree's node_modules (npm ci) and Node on PATH. Exit code 1 on any failure.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ENTRY, checkTree } from "./check-daemon-graph.mjs";
import { mangleExemptionPresent, privateNameCount, privatesSurvive } from "./check-privates.mjs";
import { STAGE_ROOT, verifyStaged } from "./stage-verify.mjs";

export function typecheckAxis(tree) {
  const config = join(tree, "src", "tsconfig.axis-check.json");
  writeFileSync(
    config,
    JSON.stringify({
      extends: "./tsconfig.base.json",
      compilerOptions: { noEmit: true, types: ["node"], skipLibCheck: false, isolatedModules: false, esModuleInterop: true },
      include: ["./vs/axis/**/*.ts"],
    }),
  );
  try {
    const r = spawnSync(join(tree, "node_modules", ".bin", "tsc"), ["-p", config], { cwd: tree, encoding: "utf8" });
    return { ok: r.status === 0, output: `${r.stdout}${r.stderr}`.trim() };
  } finally {
    rmSync(config, { force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--tree");
  const tree = resolve(i >= 0 ? process.argv[i + 1] : process.env.AXIS_CODE_OSS_TREE ?? "");
  if (i < 0 && !process.env.AXIS_CODE_OSS_TREE) {
    console.error("usage: check-staged.mjs --tree <code-oss tree>");
    process.exit(2);
  }
  let failed = false;
  const buildBundle = process.argv.includes("--build-bundle");
  try {
    const m = verifyStaged(tree);
    console.log(`1. staged output verified: ${m.files.length} files, tree ${m.treeSha256}`);
    const t = typecheckAxis(tree);
    console.log(`2. type-check of src/vs/axis with the tree's flags: ${t.ok ? "ok" : "FAILED"}`);
    if (!t.ok) {
      console.error(t.output);
      failed = true;
    }
    if (process.argv.includes("--full-typecheck")) {
      const f = spawnSync(join(tree, "node_modules", ".bin", "tsc"), ["--project", "./src/tsconfig.json", "--noEmit", "--skipLibCheck"], { cwd: tree, encoding: "utf8" });
      const axisErrors = `${f.stdout}${f.stderr}`.split("\n").filter((l) => l.includes("src/vs/axis/"));
      console.log(`2b. the tree's real typecheck-client (src/tsconfig.json): ${f.status === 0 ? "ok" : `FAILED (${axisErrors.length} error(s) in src/vs/axis)`}`);
      for (const l of axisErrors) console.error(`   ${l}`);
      if (f.status !== 0) failed = true;
    }
    const entries = [DEFAULT_ENTRY, ...m.packages.map((n) => `${STAGE_ROOT}/${n}/index.ts`)];
    const g = await checkTree({ tree, entries, graphOf: DEFAULT_ENTRY });
    console.log(`3. bundled ${entries.length} entries (${g.inputs} inputs, ${g.stagedInputs} staged); zod ${g.zod}, tree has ${g.treeZod}: ${g.violations.length === 0 ? "graph ok" : "FAILED"}`);
    for (const v of g.violations) console.error(`   ${v}`);
    if (g.violations.length > 0) failed = true;

    const exempt = mangleExemptionPresent(readFileSync(join(tree, "build", "next", "index.ts"), "utf8"));
    console.log(`4. build/next exempts vs/axis outputs from #private mangling: ${exempt ? "yes" : "NO"}`);
    if (!exempt) failed = true;
    if (buildBundle) {
      const out = "out-axis-bundle-check";
      rmSync(join(tree, out), { recursive: true, force: true });
      const r = spawnSync(process.execPath, ["build/next/index.ts", "bundle", "--minify", "--nls", "--mangle-privates", "--target", "desktop", "--out", out], { cwd: tree, stdio: "inherit" });
      if (r.status !== 0) throw new Error("the tree's bundle step failed");
      const sourcePrivates = g.stagedSources.reduce((n, t) => n + privateNameCount(t), 0);
      const builtFile = join(tree, out, DEFAULT_ENTRY.replace(/^src\//, "").replace(/\.ts$/, ".js"));
      statSync(builtFile);
      const problems = privatesSurvive({ file: builtFile, sourcePrivates, builtText: readFileSync(builtFile, "utf8") });
      console.log(`   built daemon bundle: ${privateNameCount(readFileSync(builtFile, "utf8"))} #private names, staged sources of its graph declare ${sourcePrivates}: ${problems.length === 0 ? "ok" : "FAILED"}`);
      for (const v of problems) console.error(`   ${v}`);
      if (problems.length > 0) failed = true;
    }
  } catch (e) {
    console.error(`check-staged: ${e.message}`);
    failed = true;
  }
  process.exit(failed ? 1 : 0);
}
