// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DaemonError } from "@axis/daemon";
import { MAX_UNBACKED_DISPLAY, MAX_UNBACKED_PATHS, worktreesMethods } from "@axis/protocol";
import { assertAllBacked, unbackedAmong, unbackedSummary, type UnbackedScan } from "../src/worktrees/discard-backup.js";

// SF-1 of the P1d review: a tier 2 discard has no native dialog and the backup does not keep every file, so a path the backup
// cannot keep is refused, per category, with the closed reason `unbacked_data`.
const scan: UnbackedScan = {
  skippedLarge: ["data/big.bin"],
  ignored: ["node_modules/", ".env.local"],
  skippedUnsupported: ["vendor/nested-repo"],
};
const refusal = (paths: string[]): DaemonError | undefined => {
  try {
    assertAllBacked(scan, paths);
  } catch (e) {
    assert.ok(e instanceof DaemonError, String(e));
    return e;
  }
  return undefined;
};

test("a path the backup keeps is not refused", () => {
  assert.equal(refusal(["src/a.ts", "README.md", "data/small.txt"]), undefined);
  assert.deepEqual(unbackedAmong(scan, ["src/a.ts"]), []);
});

test("each category a backup cannot keep is refused with E_CONFLICT and the closed reason unbacked_data", () => {
  for (const [label, path] of [
    ["large", "data/big.bin"],
    ["ignored file", ".env.local"],
    ["ignored directory (the path inside it)", "node_modules/left-pad/index.js"],
    ["ignored directory (the directory itself)", "node_modules"],
    ["unsupported (nested repository)", "vendor/nested-repo"],
    ["a directory that contains an unbacked entry", "data"],
    ["the same entry in another case", "DATA/Big.BIN"],
    ["the entry with a trailing slash", "vendor/nested-repo/"],
  ] as const) {
    const e = refusal(["src/a.ts", path]);
    assert.ok(e, `${label} must be refused`);
    assert.deepEqual([e.code, e.details], ["E_CONFLICT", { reason: "unbacked_data" }], label);
    assert.equal(e.message.includes(path), false, `${label}: the refusal does not name the path`);
  }
});

test("a sibling that only shares a prefix with an unbacked entry is not refused", () => {
  assert.equal(refusal(["data/big.bin.txt", "node_modules2/x", "vendor/nested-repo2"]), undefined);
});

test("the reply summary is bounded, escaped for display and valid for the contract", () => {
  const many = Array.from({ length: MAX_UNBACKED_PATHS + 20 }, (_, i) => `big/${i}.bin`);
  const summary = unbackedSummary(many);
  assert.equal(summary.paths.length, MAX_UNBACKED_PATHS);
  const nasty = unbackedSummary(["a‮b\nc", "x".repeat(MAX_UNBACKED_DISPLAY * 2)]);
  assert.equal(nasty.paths[0], "a\\u{202e}b\\u{a}c");
  assert.ok((nasty.paths[1] ?? "").length <= MAX_UNBACKED_DISPLAY);
  const reply = { backupRef: "refs/axis/backup/ws-1/1", discarded: ["a"], unbacked: nasty };
  assert.equal(worktreesMethods.discard.response.safeParse(reply).success, true);
});
