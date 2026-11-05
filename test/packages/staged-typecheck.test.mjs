// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Type-checks the staged packages (the exact files the Code OSS hook writes) under the timer typings of Code OSS,
// where `setTimeout` returns an opaque `TimeoutHandle` (ADR 0005 D3.4). Catches a package that compiles in
// packages/ against Node's `Timeout` but not in the Code OSS tree, without a Code OSS checkout. Needs
// `npm ci --ignore-scripts`; skipped without node_modules/typescript.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { STAGE_ROOT, stage } from "../../scripts/code-oss/stage-packages.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const tsc = join(repo, "node_modules", "typescript", "bin", "tsc");
const skip = existsSync(join(repo, "node_modules", "zod", "package.json")) && existsSync(tsc) ? false : "run `npm ci --ignore-scripts` first";

test("the staged packages type-check under Code OSS's opaque timer handle", { skip, timeout: 240_000 }, () => {
  const tree = mkdtempSync(join(tmpdir(), "axis-staged-tc-"));
  try {
    stage({ repo, tree });
    cpSync(join(repo, "test/packages/fixtures/code-oss-timers.d.ts"), join(tree, "code-oss-timers.d.ts"));
    // Code OSS lists no `types`: Node's typings are loaded by its first sources (`tsc --listFilesOnly` puts
    // @types/node before src/typings/base-common.d.ts), and a later global overload is tried first. A root file
    // that loads Node's typings, listed before the timer typings, reproduces that order; the other way round
    // Node's `Timeout` wins and the check passes whatever the packages do.
    writeFileSync(join(tree, "node-types.d.ts"), '/// <reference types="node" />\n');
    // Flags are those of tsconfig.base.json except the module settings the Code OSS tree uses for its own sources.
    writeFileSync(join(tree, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2023", lib: ["ES2023", "DOM", "DOM.Iterable"], module: "ESNext", moduleResolution: "Bundler", strict: true,
        noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noImplicitOverride: true,
        noFallthroughCasesInSwitch: true, noImplicitReturns: true, noUnusedLocals: true,
        skipLibCheck: true, noEmit: true, allowImportingTsExtensions: true,
        types: [], typeRoots: [join(repo, "node_modules", "@types")],
      },
      include: ["./node-types.d.ts", "./code-oss-timers.d.ts", `./${STAGE_ROOT}/**/*.ts`],
    }));
    const r = spawnSync(process.execPath, [tsc, "-p", join(tree, "tsconfig.json")], { cwd: tree, encoding: "utf8" });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`.split("\n").slice(0, 30).join("\n"));
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});
