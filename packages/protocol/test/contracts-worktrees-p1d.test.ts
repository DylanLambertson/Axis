// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_DISCARD_PATHS, MAX_USER_EDITING_PATHS, lookupMethod, type MethodSpec } from "../src/index.js";
import { WORKTREE_P1D_SAMPLES } from "./samples-worktrees.js";
import { accepts, rejects, runSuite, schemaOf } from "./suite.js";

// P1d: finalise is tier 4 with an approval reference; discard and setUserEditing are new, strict and bounded.
runSuite(WORKTREE_P1D_SAMPLES);

const W = "axis.worktrees";
const REF = { challengeId: "A".repeat(22) };

test("finalise is a tier 4 destructive method that carries the approval reference (the daemon requires one at tier 3 and above)", () => {
  const spec = lookupMethod(W, 1, "finalise") as MethodSpec;
  assert.equal(spec.tier, 4);
  assert.equal(spec.sideEffect, "destructive");
  assert.equal(spec.idempotency, "required");
  const req = schemaOf(W, "finalise", "request");
  accepts(req, { id: "ws-1", outcome: "merged" }, "first call");
  accepts(req, { id: "ws-1", outcome: "merged", approval: REF }, "retry");
  rejects(req, { id: "ws-1", outcome: "merged", approval: { challengeId: "short" } }, "short challenge id");
  rejects(req, { id: "ws-1", outcome: "merged", approval: {} }, "empty approval");
  rejects(req, { id: "ws-1", outcome: "merged", force: true }, "unknown key");
  rejects(req, { id: "ws-1", outcome: "deleted" }, "outcome outside the closed set");
  rejects(req, { id: "ws-1", outcome: "merged", approval: "x" }, "approval is not a string");
});

test("discard takes workspace-relative paths only, at least one and at most the bound, and no hunks yet", () => {
  const req = schemaOf(W, "discard", "request");
  accepts(req, { id: "ws-1", paths: ["a.txt"] }, "one path");
  accepts(req, { id: "ws-1", paths: Array.from({ length: MAX_DISCARD_PATHS }, (_, i) => `f${i}.txt`) }, "at the bound");
  rejects(req, { id: "ws-1", paths: Array.from({ length: MAX_DISCARD_PATHS + 1 }, (_, i) => `f${i}.txt`) }, "over the bound");
  rejects(req, { id: "ws-1", paths: [] }, "no paths");
  rejects(req, { id: "ws-1" }, "missing paths");
  rejects(req, { id: "ws-1", paths: ["a.txt"], hunks: [] }, "hunks are not in 1a");
  rejects(req, { id: "ws-1", paths: ["a.txt"], approval: REF }, "tier 2: no approval field");
  rejects(req, { id: "ws-1", paths: ["a.txt"], path: "/etc" }, "no path key");
  for (const bad of ["/etc/passwd", "../x", "a/../b", ".git/config", "a/.GIT/x", "a\\b", ":(top)x", "-rf", "C:x", "", "a//b", "./a", "a\u0000b", "a‮b"]) {
    rejects(req, { id: "ws-1", paths: [bad] }, `path ${JSON.stringify(bad)}`);
  }
  rejects(req, { id: "-x", paths: ["a"] }, "id with a leading dash");
});

test("discard's reply is a backup ref and the paths, both bounded and strict", () => {
  const res = schemaOf(W, "discard", "response");
  accepts(res, { backupRef: "refs/axis/backup/ws-1/1", discarded: [] }, "empty");
  rejects(res, { backupRef: "r".repeat(257), discarded: [] }, "long ref");
  rejects(res, { backupRef: "r", discarded: ["../x"] }, "bad path");
  rejects(res, { backupRef: "r", discarded: Array.from({ length: MAX_DISCARD_PATHS + 1 }, (_, i) => `f${i}`) }, "too many");
  rejects(res, { backupRef: "r", discarded: [], extra: 1 }, "extra key");
});

test("discard is tier 2 write with a required key; setUserEditing is tier 2 write with none", () => {
  const discard = lookupMethod(W, 1, "discard") as MethodSpec;
  const editing = lookupMethod(W, 1, "setUserEditing") as MethodSpec;
  assert.deepEqual([discard.tier, discard.sideEffect, discard.idempotency], [2, "write", "required"]);
  assert.deepEqual([editing.tier, editing.sideEffect, editing.idempotency], [2, "write", "none"]);
});

test("setUserEditing replaces the advisory set: an empty list clears it, the list is bounded, paths are relative", () => {
  const req = schemaOf(W, "setUserEditing", "request");
  accepts(req, { id: "ws-1", paths: [] }, "clear");
  accepts(req, { id: "ws-1", paths: ["a.txt", "src/b.ts"] }, "two");
  accepts(req, { id: "ws-1", paths: Array.from({ length: MAX_USER_EDITING_PATHS }, (_, i) => `f${i}.txt`) }, "at the bound");
  rejects(req, { id: "ws-1", paths: Array.from({ length: MAX_USER_EDITING_PATHS + 1 }, (_, i) => `f${i}.txt`) }, "over the bound");
  rejects(req, { id: "ws-1" }, "missing paths");
  rejects(req, { id: "ws-1", paths: ["/abs"] }, "absolute");
  rejects(req, { id: "ws-1", paths: [".git/HEAD"] }, ".git");
  rejects(req, { id: "ws-1", paths: [], approval: REF }, "no approval field");
  rejects(req, { id: "ws-1", paths: [], editing: true }, "unknown key");
  rejects(schemaOf(W, "setUserEditing", "response"), { id: "ws-1", paths: [] }, "the reply echoes nothing else");
});

test("discard's reply can say what the backup did not keep: a bounded count and display-safe paths, optional, strict", () => {
  const res = schemaOf(W, "discard", "response");
  const base = { backupRef: "refs/axis/backup/ws-1/1", discarded: ["big.bin"] };
  accepts(res, { ...base, unbacked: { count: 1, paths: ["big.bin"] } }, "one");
  accepts(res, { ...base, unbacked: { count: 0, paths: [] } }, "empty");
  rejects(res, { ...base, unbacked: { count: -1, paths: [] } }, "negative count");
  rejects(res, { ...base, unbacked: { count: MAX_DISCARD_PATHS + 1, paths: [] } }, "count over the bound");
  rejects(res, { ...base, unbacked: { count: 1.5, paths: [] } }, "fractional count");
  rejects(res, { ...base, unbacked: { count: 1, paths: Array.from({ length: 51 }, (_, i) => `f${i}`) } }, "too many paths");
  rejects(res, { ...base, unbacked: { count: 1, paths: ["a".repeat(257)] } }, "path too long");
  rejects(res, { ...base, unbacked: { count: 1, paths: ["a\u202Eb"] } }, "bidi character in a display path");
  rejects(res, { ...base, unbacked: { count: 1, paths: ["a\nb"] } }, "control character in a display path");
  rejects(res, { ...base, unbacked: { count: 1, paths: [], extra: 1 } }, "extra key in unbacked");
  rejects(res, { ...base, unbacked: null }, "null");
});
