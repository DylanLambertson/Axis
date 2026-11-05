// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Stages the REAL packages/* and the installed node_modules/zod into a temporary tree (ADR 0005 D3, spike
// criteria 4 and 6 at the unit level). Needs `npm ci --ignore-scripts`; skipped without node_modules/zod.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { STAGE_ROOT, stage } from "../../scripts/code-oss/stage-packages.mjs";
import { verifyStaged } from "../../scripts/code-oss/stage-verify.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const skip = existsSync(join(repo, "node_modules", "zod", "package.json")) ? false : "run `npm ci --ignore-scripts` first";
const pinned = JSON.parse(readFileSync(join(repo, "packages/protocol/package.json"), "utf8")).dependencies.zod;

function withTree(fn) {
  const tree = mkdtempSync(join(tmpdir(), "axis-stage-real-"));
  try {
    return fn(tree);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

test("the real packages stage, and the staged tree passes the allowlist", { skip }, () => {
  withTree((tree) => {
    const m = stage({ repo, tree });
    const dirs = readdirSync(join(repo, "packages"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    assert.deepEqual(m.packages, dirs);
    assert.equal(verifyStaged(tree).treeSha256, m.treeSha256);
  });
});

test("criterion: staged packages resolve the pinned zod, never the tree's own copy", { skip }, () => {
  withTree((tree) => {
    const m = stage({ repo, tree });
    assert.equal(m.zod, pinned);
    assert.equal(JSON.parse(readFileSync(join(tree, STAGE_ROOT, "vendor/zod/package.json"), "utf8")).version, pinned);
    const rewritten = m.files.filter((f) => f.path.endsWith(".ts") && !f.path.startsWith("vendor/"));
    assert.ok(rewritten.length > 50);
    let importsVendored = 0;
    for (const f of rewritten) {
      const text = readFileSync(join(tree, STAGE_ROOT, f.path), "utf8");
      assert.doesNotMatch(text, /from\s+["']zod["']|import\s*\(\s*["']zod["']/, `${f.path} still imports bare zod`);
      if (/vendor\/zod\/index\.js/.test(text)) importsVendored++;
    }
    assert.ok(importsVendored > 0, "at least one package imports the vendored zod");
  });
});

test("criterion: the hook is deterministic and idempotent on the real packages", { skip }, () => {
  withTree((tree) => {
    const a = stage({ repo, tree });
    const b = stage({ repo, tree });
    assert.equal(a.treeSha256, b.treeSha256);
    assert.deepEqual(a.files, b.files);
  });
  withTree((other) => {
    withTree((tree) => assert.equal(stage({ repo, tree }).treeSha256, stage({ repo, tree: other }).treeSha256));
  });
});

test("no test-only or generated input is staged", { skip }, () => {
  withTree((tree) => {
    const m = stage({ repo, tree });
    for (const f of m.files) {
      assert.doesNotMatch(f.path, /(^|\/)(test|dist|node_modules|contract)\//, f.path);
      assert.doesNotMatch(f.path, /\.test\.ts$/, f.path);
    }
  });
});
