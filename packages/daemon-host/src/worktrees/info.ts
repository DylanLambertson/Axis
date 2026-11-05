// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { WorktreesResponse } from "@axis/protocol";
import type { Workspace } from "@axis/journal";
import type { DirtyEntry, ListedWorktree, ManagerStatus } from "./shapes.js";

export type WorktreeInfo = WorktreesResponse<"list">["worktrees"][number];

/** Staged, unstaged and untracked counts from the porcelain codes (a file can count as both staged and unstaged). */
export function dirtyCounts(dirty: readonly DirtyEntry[]): { staged: number; unstaged: number; untracked: number } {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const d of dirty) {
    if (d.index === "?" || d.worktree === "?") {
      untracked++;
      continue;
    }
    if (d.index !== " " && d.index !== "!") staged++;
    if (d.worktree !== " " && d.worktree !== "!") unstaged++;
  }
  return { staged, unstaged, untracked };
}

/** The wire state of a journal workspace; the journal-only crash-visibility states are not sent. */
export function wireState(state: Workspace["state"]): "READY" | "FINALISED" | "CLEANED" | undefined {
  if (state === "READY" || state === "FINALISED") return state;
  return state === "REMOVED" ? "CLEANED" : undefined;
}

const branchName = (ref: string | null): string | null => (ref === null ? null : ref.replace(/^refs\/heads\//, ""));
const HEAD = /^[0-9a-f]{40,64}$/;

/**
 * One workspace as the contract describes it. The journal row is the authority for id, project, branch, base and
 * state; `live` (the manager's status, when the worktree could be read) adds head, dirtiness and ahead or behind.
 * `path` is for display only: the record's own path, never accepted back as input.
 */
export function workspaceInfo(ws: Workspace, live: ManagerStatus | undefined, present: boolean): WorktreeInfo {
  const state = wireState(ws.state);
  return {
    id: ws.id,
    origin: "axis",
    projectId: ws.projectId,
    ...(state === undefined ? {} : { state }),
    branch: live?.branch ?? ws.branch,
    baseRef: ws.baseRef,
    baseSha: ws.baseSha,
    head: live !== undefined && HEAD.test(live.head) ? live.head : null,
    path: ws.worktreePath ?? "",
    locked: ws.lockState === "locked",
    present,
    ...(live === undefined ? {} : { dirty: dirtyCounts(live.dirty), ahead: live.ahead, behind: live.behind }),
  };
}

/** A linked worktree Axis did not create (no id, no state). */
export function externalInfo(entry: ListedWorktree, projectId: string): WorktreeInfo {
  return {
    origin: "external",
    projectId,
    branch: branchName(entry.branch),
    head: entry.head !== null && HEAD.test(entry.head) ? entry.head : null,
    path: entry.path,
    locked: entry.locked,
    present: !entry.prunable,
  };
}
