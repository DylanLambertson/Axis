// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PSH-1: scan the patch of every commit that a push will send, not the net change between two trees.
import { OBJECT_ID, type DaemonGit } from "./args.js";
import { GitOpsError } from "./errors.js";
import type { GitOpsDeps, SecretFinding, WorktreeRef } from "./types.js";

/** Per-commit patch size handed to the scanner. */
export const MAX_DIFF = 8 * 1024 * 1024;

export interface OutgoingScan {
  readonly findings: readonly SecretFinding[];
  /** True when any commit's patch was larger than the scanner was given. */
  readonly truncated: boolean;
}

function unavailable(what: string): GitOpsError {
  return new GitOpsError("E_UNAVAILABLE", `could not ${what} for the secret scan`);
}

/**
 * Runs the scanner once per commit in `base..tip`, oldest first. Merge commits are diffed against every parent (-m),
 * so a secret that exists only in a merge resolution is seen. Attributes, textconv, external diff, submodule
 * recursion and rename detection are all off; the content scanned is the content pushed.
 */
export async function scanOutgoing(deps: GitOpsDeps, git: DaemonGit, worktree: WorktreeRef, base: string, tip: string): Promise<OutgoingScan> {
  const scanner = deps.scanner;
  if (!scanner) return { findings: [], truncated: false };
  const list = await git(["rev-list", "--reverse", "--end-of-options", tip, `^${base}`]);
  if (list.code !== 0) throw unavailable("list the outgoing commits");
  const commits = list.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (commits.some((c) => !OBJECT_ID.test(c))) throw unavailable("list the outgoing commits");
  const findings: SecretFinding[] = [];
  let truncated = false;
  for (const commit of commits) {
    const d = await git([
      "diff-tree", "-p", "-m", "--root", "--no-commit-id", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv",
      "--submodule=short", "--ignore-submodules=all", "--end-of-options", commit,
    ]);
    if (d.code !== 0) throw unavailable("compute the outgoing diff");
    const cut = d.stdout.length > MAX_DIFF;
    if (cut) truncated = true;
    for (const f of await scanner(cut ? d.stdout.slice(0, MAX_DIFF) : d.stdout, { worktree, truncated: cut, commit })) findings.push({ ...f, commit });
  }
  return { findings, truncated };
}
