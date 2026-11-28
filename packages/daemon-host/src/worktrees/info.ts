// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { WorktreesResponse } from "@axis/protocol";
import type { Workspace } from "@axis/journal";
import type { DirtyEntry, ListedWorktree, ManagerStatus } from "./shapes.js";

/** A workspace or external row (the shape `status` and `create` answer with). */
export type WorktreeInfo = WorktreesResponse<"status">["worktrees"][number];
/** The local checkout row a `list` with `includeLocal` starts with (DC-7). */
export type LocalInfo = Extract<WorktreesResponse<"list">["worktrees"][number], { origin: "local" }>;

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

/** The wire's bound on a branch name (`worktreeInfoSchema`, `localCheckoutInfoSchema`). */
const MAX_BRANCH = 256;
/**
 * A branch for display: `refs/heads/` dropped, and a name longer than the wire allows (git allows longer ones, such as
 * `<200 chars>/<200 chars>`) cut to 255 units plus U+2026, never splitting a surrogate pair, so one long name cannot make the
 * whole list reply fail its schema (DC-7 review 1 NIT-1).
 */
function branchName(ref: string | null): string | null {
  if (ref === null) return null;
  const name = ref.replace(/^refs\/heads\//, "");
  if (name.length <= MAX_BRANCH) return name;
  let out = "";
  for (const ch of name) {
    if (out.length + ch.length > MAX_BRANCH - 1) break;
    out += ch;
  }
  return `${out}\u2026`;
}
/** Characters the shell refuses in a path (control, format, line separators): such a row would drop the whole reply there. */
const UNSAFE_PATH = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const MAX_PATH = 4096;
const HEAD = /^[0-9a-f]{40,64}$/;
/** A real object id: git lists an unborn branch's head as all zeros. */
const realHead = (h: string | null): string | null => (h !== null && HEAD.test(h) && !/^0+$/.test(h) ? h : null);

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

/**
 * The repository's own checkout (DC-7, docs/design/worktrees-local-checkout.md): the main entry of the `git worktree list` the
 * service already ran. No id, state or counts (no `status` runs in the user's checkout), never locked. Undefined for a path
 * the shell could not show.
 */
export function localInfo(entry: ListedWorktree, projectId: string): LocalInfo | undefined {
  // The path is display text the renderer escapes anyway; one it could not show (a control or format character, or longer
  // than the wire allows) leaves THIS row out rather than failing the whole reply (DC-7 review 1 NIT-3).
  if (entry.path.length > MAX_PATH || UNSAFE_PATH.test(entry.path)) return undefined;
  return { origin: "local", projectId, branch: branchName(entry.branch), head: realHead(entry.head), path: entry.path, locked: false, present: !entry.prunable };
}
