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
//   3. the daemon entry and every staged package index bundle with the tree's esbuild, and the module graph is
//      clean (check-daemon-graph.mjs): zod 4.6.6 vendored, never the tree's copy; no restricted module leaks.
// Needs the tree's node_modules (npm ci) and Node on PATH. Exit code 1 on any failure.
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ENTRY, checkTree } from "./check-daemon-graph.mjs";
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
  try {
    const m = verifyStaged(tree);
    console.log(`1. staged output verified: ${m.files.length} files, tree ${m.treeSha256}`);
    const t = typecheckAxis(tree);
    console.log(`2. type-check of src/vs/axis with the tree's flags: ${t.ok ? "ok" : "FAILED"}`);
    if (!t.ok) {
      console.error(t.output);
      failed = true;
    }
    const entries = [DEFAULT_ENTRY, ...m.packages.map((n) => `${STAGE_ROOT}/${n}/index.ts`)];
    const g = await checkTree({ tree, entries });
    console.log(`3. bundled ${entries.length} entries (${g.inputs} inputs, ${g.stagedInputs} staged); zod ${g.zod}, tree has ${g.treeZod}: ${g.violations.length === 0 ? "graph ok" : "FAILED"}`);
    for (const v of g.violations) console.error(`   ${v}`);
    if (g.violations.length > 0) failed = true;
  } catch (e) {
    console.error(`check-staged: ${e.message}`);
    failed = true;
  }
  process.exit(failed ? 1 : 0);
}
