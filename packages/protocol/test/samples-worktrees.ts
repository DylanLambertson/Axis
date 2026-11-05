// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Sample } from "./suite.js";

const info = {
  id: "ws-1",
  origin: "axis",
  projectId: "p1",
  state: "READY",
  branch: "axis/fix-login",
  baseRef: "main",
  baseSha: "1".repeat(40),
  head: "2".repeat(40),
  path: "/work/ws-1",
  locked: false,
  present: true,
  dirty: { staged: 1, unstaged: 2, untracked: 3 },
  ahead: 1,
  behind: 0,
};
const W = "axis.worktrees";
/** `branch` and `head` are nullable, so null stays valid there. */
const NULLABLE = /^null at (worktree|worktrees\.\d+)\.(branch|head)$/;

export const WORKTREE_SAMPLES: readonly Sample[] = [
  { contract: W, method: "list", side: "request", name: "list", value: { projectId: "p1" } },
  { contract: W, method: "list", side: "response", name: "one", value: { worktrees: [structuredClone(info)] }, toleratedPattern: NULLABLE },
  { contract: W, method: "status", side: "request", name: "status", value: { ids: ["ws-1", "ws-2"] } },
  { contract: W, method: "status", side: "response", name: "one", value: { worktrees: [structuredClone(info)] }, toleratedPattern: NULLABLE },
  { contract: W, method: "create", side: "request", name: "with a base ref", value: { projectId: "p1", name: "fix login", baseRef: "main" } },
  { contract: W, method: "create", side: "response", name: "created", value: { id: "ws-1", worktree: structuredClone(info) }, toleratedPattern: NULLABLE },
  { contract: W, method: "finalise", side: "request", name: "merged", value: { id: "ws-1", outcome: "merged" } },
  { contract: W, method: "finalise", side: "response", name: "finalised", value: { id: "ws-1", state: "FINALISED", archiveRef: "refs/axis/archive/ws-1" } },
  { contract: W, method: "remove", side: "request", name: "with approval", value: { id: "ws-1", deleteBranch: true, approval: { challengeId: "A".repeat(22), originalRequestId: "req-1" } } },
  { contract: W, method: "remove", side: "response", name: "cleaned", value: { id: "ws-1", state: "CLEANED", backupRef: "refs/axis/backup/ws-1" } },
  { contract: W, method: "restoreFromRunBase", side: "request", name: "two paths", value: { runId: "run-1", id: "ws-1", paths: ["a.txt", "src/b.ts"] } },
  { contract: W, method: "restoreFromRunBase", side: "response", name: "restored", value: { backupRef: "refs/axis/backup/ws-1", restored: ["a.txt"] } },
];
