// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The worktree is read once, through git, into a tree object (design §2). Everything after works on objects.
import { escapeForDisplay } from "./display.js";
import { conflict, internal, stderrSnippet, unavailable } from "./errors.js";
import { OBJECT_ID, expectComplete, expectOk, type ReviewGit } from "./gitcall.js";
import { parseRaw } from "./changes.js";
import { resolveLimits } from "./limits.js";
import { acquireIndex } from "./tempindex.js";
import type { ReviewDeps, SkippedFile } from "./types.js";

export interface Snapshot {
  readonly tree: string;
  /** Files over the size cap: not in the tree, and said so. */
  readonly skipped: readonly SkippedFile[];
  readonly skippedCount: number;
}

const ZERO = /^0+$/;

/** Blob sizes of a tree's changed entries that are over the cap, from one `cat-file --batch-check`. */
async function oversized(git: ReviewGit, againstTree: string, tree: string, cap: number): Promise<{ path: string; size: number; base: { mode: string; oid: string } | null }[]> {
  const raw = expectComplete(await git(["diff-tree", "-r", "-z", "--raw", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv", againstTree, tree]), "list the worktree changes");
  // The file-count bound belongs to the list and to the outside-the-agent report, which say so; here every entry is scanned.
  // A runner that cut the output off is refused by `expectComplete` above.
  const { entries } = parseRaw(raw, Number.MAX_SAFE_INTEGER);
  const cand = entries.filter((e) => e.status !== "D" && e.newMode !== "160000" && !ZERO.test(e.newOid));
  if (cand.length === 0) return [];
  const out = expectComplete(await git(["cat-file", "--batch-check=%(objectsize)"], { stdin: `${cand.map((e) => e.newOid).join("\n")}\n` }), "read object sizes");
  const lines = out.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length !== cand.length) throw unavailable("git produced object sizes that could not be read");
  const big: { path: string; size: number; base: { mode: string; oid: string } | null }[] = [];
  lines.forEach((l, i) => {
    if (!/^\d{1,15}$/.test(l)) throw unavailable("an object of the worktree is missing from the repository");
    const e = cand[i];
    if (e && Number(l) > cap) big.push({ path: e.path, size: Number(l), base: e.status === "A" ? null : { mode: e.oldMode, oid: e.oldOid } });
  });
  return big;
}

/**
 * The worktree tree: the tree of `againstTree` plus every non-ignored change in the worktree, built in a temporary index
 * with `add -A` (lstat, so a symlink is a link and is never followed; filters are neutralised by the prefix, which is why a
 * path with a filter attribute is never offered, see changes.ts). A file over `maxSnapshotFileBytes` is put back to its
 * base state and reported in `skipped`, the same rule the run-base snapshots follow. The user's index, refs and files are
 * not touched.
 */
export async function snapshotWorktreeDetailed(deps: ReviewDeps, git: ReviewGit, againstTree: string): Promise<Snapshot> {
  const limits = resolveLimits(deps.limits);
  const idx = await acquireIndex(deps.tempIndex);
  try {
    expectOk(await git(["read-tree", againstTree], { index: idx.path }), "read the base tree");
    const added = await git(["add", "-A"], { index: idx.path });
    if (added.code !== 0) throw conflict(`the worktree could not be read: ${stderrSnippet(added.stderr)}`, "snapshot_failed");
    let tree = expectOk(await git(["write-tree"], { index: idx.path }), "write the worktree tree").trim();
    if (!OBJECT_ID.test(tree)) throw unavailable("git did not return a tree id for the worktree");
    const big = await oversized(git, againstTree, tree, limits.maxSnapshotFileBytes);
    if (big.length === 0) return { tree, skipped: [], skippedCount: 0 };
    const zero = "0".repeat(againstTree.length);
    // NUL-terminated records: any path is safe. The result is checked again below, because --index-info ignores a bad path.
    const lines = big.map((b) => (b.base === null ? `0 ${zero}\t${b.path}\0` : `${b.base.mode} ${b.base.oid}\t${b.path}\0`));
    const upd = await git(["update-index", "-z", "--index-info"], { index: idx.path, stdin: lines.join("") });
    if (upd.code !== 0) throw conflict("git refused to leave out a file that is too large", "snapshot_failed");
    tree = expectOk(await git(["write-tree"], { index: idx.path }), "write the worktree tree").trim();
    if (!OBJECT_ID.test(tree)) throw unavailable("git did not return a tree id for the worktree");
    if ((await oversized(git, againstTree, tree, limits.maxSnapshotFileBytes)).length > 0) throw internal("a file that is too large is still in the worktree tree");
    const skipped = big.slice(0, limits.maxFiles).map((b) => ({
      path: b.path,
      displayPath: escapeForDisplay(b.path, { maxLength: limits.maxDisplay, cut: "middle" }),
      size: b.size,
      reason: "too_large_to_review" as const,
    }));
    return { tree, skipped, skippedCount: big.length };
  } finally {
    await idx.release();
  }
}

export async function snapshotWorktree(deps: ReviewDeps, git: ReviewGit, againstTree: string): Promise<string> {
  return (await snapshotWorktreeDetailed(deps, git, againstTree)).tree;
}
