// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The worktree is read once, through git, into a tree object (design §2). Everything after works on objects.
import { conflict, stderrSnippet, unavailable } from "./errors.js";
import { OBJECT_ID, expectOk, type ReviewGit } from "./gitcall.js";
import type { ReviewDeps } from "./types.js";

/**
 * The worktree tree: the tree of `againstTree` plus every non-ignored change in the worktree, built in a temporary index
 * with `add -A` (lstat, so a symlink is a link and is never followed; clean filters are neutralised by the prefix).
 * The user's index, refs and files are not touched. The index file is released after git has finished with it.
 */
export async function snapshotWorktree(deps: ReviewDeps, git: ReviewGit, againstTree: string): Promise<string> {
  const idx = await deps.tempIndex.create();
  try {
    expectOk(await git(["read-tree", againstTree], { index: idx.path }), "read the base tree");
    const added = await git(["add", "-A"], { index: idx.path });
    if (added.code !== 0) throw conflict(`the worktree could not be read: ${stderrSnippet(added.stderr)}`, "snapshot_failed");
    const tree = expectOk(await git(["write-tree"], { index: idx.path }), "write the worktree tree").trim();
    if (!OBJECT_ID.test(tree)) throw unavailable("git did not return a tree id for the worktree");
    return tree;
  } finally {
    try {
      await idx.dispose();
    } catch {
      /* a leftover temporary file is the provider's to clean up; it must not mask the result */
    }
  }
}
