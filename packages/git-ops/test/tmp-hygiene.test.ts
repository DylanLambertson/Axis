// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Test hygiene: every temporary directory comes from tmp()/fixture(), which removes it; nothing calls mkdtemp directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTmp, fixture, liveTmpDirs, tmp } from "./realFixture.js";

// The compiled test runs from dist/test; the sources are two directories up.
const testDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test");

test("the helpers register the directories they make, and cleanupTmp removes them", () => {
  const f = fixture();
  const d = tmp("axis-hygiene-");
  assert.ok(liveTmpDirs().includes(f.root), "fixture() registers its root");
  assert.ok(liveTmpDirs().includes(d), "tmp() registers its directory");
  assert.ok(existsSync(d) && existsSync(f.root));
  cleanupTmp();
  assert.equal(existsSync(d), false);
  assert.equal(existsSync(f.root), false);
  assert.deepEqual(liveTmpDirs(), []);
});

test("no test or helper creates a temporary directory except through tmp()", () => {
  const offenders = readdirSync(testDir)
    .filter((n) => n.endsWith(".ts") && n !== "realFixture.ts" && n !== "tmp-hygiene.test.ts")
    .filter((n) => /\bmkdtemp(Sync)?\s*\(/.test(readFileSync(join(testDir, n), "utf8")));
  assert.deepEqual(offenders, []);
});
