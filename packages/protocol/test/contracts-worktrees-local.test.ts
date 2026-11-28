// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { accepts, rejects, runSuite, schemaOf, type Sample } from "./suite.js";

// DC-7 (docs/design/worktrees-local-checkout.md): `list { projectId, includeLocal: true }` adds at most one row of origin
// "local", first, for the repository's own checkout. Opt-in, so a client that never asks gets no new origin value. The row
// carries no id, state, base, dirty counts or ahead/behind, and is never valid in a status or create reply.
// Mutants: an includeLocal that takes false, a local row that takes an id, state or counts, a local row accepted in status,
// a second local row, a local row after another row, a locked local row.

const W = "axis.worktrees";
const local = { origin: "local", projectId: "p1", branch: "main", head: "2".repeat(40), path: "/home/u/repo", locked: false, present: true };
const external = { origin: "external", projectId: "p1", branch: "x", head: "3".repeat(40), path: "/home/u/repo-x", locked: false, present: true };
const NULLABLE = /^null at worktrees\.\d+\.(branch|head)$/;

const SAMPLES: readonly Sample[] = [
  { contract: W, method: "list", side: "request", name: "with the local checkout", value: { projectId: "p1", includeLocal: true } },
  { contract: W, method: "list", side: "response", name: "local first", value: { worktrees: [structuredClone(local), structuredClone(external)] }, toleratedPattern: NULLABLE },
];
runSuite(SAMPLES);

test("includeLocal is the literal true or absent", () => {
  const req = schemaOf(W, "list", "request");
  accepts(req, { projectId: "p1" }, "absent");
  accepts(req, { projectId: "p1", includeLocal: true }, "true");
  for (const v of [false, "true", 1, null]) rejects(req, { projectId: "p1", includeLocal: v }, `includeLocal ${JSON.stringify(v)}`);
});

test("a local row carries no id, state, base, counts or lock, and is refused outside a list reply", () => {
  const list = schemaOf(W, "list", "response");
  accepts(list, { worktrees: [local] }, "alone");
  accepts(list, { worktrees: [{ ...local, branch: null, head: null, present: false }] }, "detached, unborn, missing");
  for (const [k, v] of [["id", "ws-1"], ["state", "READY"], ["baseRef", "main"], ["baseSha", "1".repeat(40)], ["dirty", { staged: 0, unstaged: 0, untracked: 0 }], ["ahead", 0], ["behind", 0]] as const) {
    rejects(list, { worktrees: [{ ...local, [k]: v }] }, `local with ${k}`);
  }
  rejects(list, { worktrees: [{ ...local, locked: true }] }, "a locked local row");
  rejects(schemaOf(W, "status", "response"), { worktrees: [local] }, "local in a status reply");
  rejects(schemaOf(W, "create", "response"), { id: "ws-1", worktree: local }, "local in a create reply");
});

test("at most one local row, and only first", () => {
  const list = schemaOf(W, "list", "response");
  rejects(list, { worktrees: [local, local] }, "two local rows");
  rejects(list, { worktrees: [external, local] }, "local after another row");
  accepts(list, { worktrees: [external] }, "none");
  accepts(list, { worktrees: [] }, "empty");
});

test("an unknown origin is still refused", () => {
  assert.ok(schemaOf(W, "list", "response"));
  rejects(schemaOf(W, "list", "response"), { worktrees: [{ ...local, origin: "main" }] }, "origin main");
});
