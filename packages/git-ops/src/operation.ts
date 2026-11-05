// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// G5: refuse a commit while a merge, cherry-pick, revert, rebase, bisect or unresolved index is in progress.
import { lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { DaemonGit } from "./args.js";
import { GitOpsError } from "./errors.js";
import type { GitOpsDeps, WorktreeRef } from "./types.js";

/** Git's own names for the state of an operation that has not finished. Each is resolved with `rev-parse --git-path`. */
export const OPERATION_MARKERS = [
  "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG", "BISECT_START",
] as const;

/** Whether a path exists: a missing path (or a missing parent) is false, any other error (EACCES, ELOOP...) is thrown so it refuses. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw e;
  }
}

/**
 * Throws E_CONFLICT `operation_in_progress` when the index has unmerged entries or any marker exists. The marker paths
 * come from git (`--git-path`), so a linked worktree's own directory is the one asked about, not the common directory.
 * An answer that cannot be read (a path with a newline, a failed call, a stat error other than "absent") refuses too.
 */
export async function assertNoOperation(git: DaemonGit, w: WorktreeRef, deps: GitOpsDeps): Promise<void> {
  const unmerged = await git(["ls-files", "--unmerged", "-z"]);
  if (unmerged.code !== 0) throw new GitOpsError("E_UNAVAILABLE", "the index could not be read");
  if (unmerged.stdout.length > 0) throw opInProgress("the index has unmerged entries");
  const args = OPERATION_MARKERS.flatMap((m) => ["--git-path", m]);
  const r = await git(["rev-parse", ...args]);
  const paths = r.stdout.endsWith("\n") ? r.stdout.slice(0, -1).split("\n") : [];
  if (r.code !== 0 || paths.length !== OPERATION_MARKERS.length || paths.some((p) => p === "")) {
    throw new GitOpsError("E_UNAVAILABLE", "the repository state could not be read, so an operation in progress cannot be ruled out");
  }
  const exists = deps.fileExists ?? pathExists;
  for (const [i, p] of paths.entries()) {
    if (await exists(isAbsolute(p) ? p : join(w.workTree, p))) throw opInProgress(`${OPERATION_MARKERS[i] as string} exists`);
  }
}

function opInProgress(what: string): GitOpsError {
  return new GitOpsError("E_CONFLICT", `an operation is in progress (${what}); finish or abort it before committing`, { reason: "operation_in_progress" });
}
