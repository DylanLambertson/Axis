// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The reviewed-tree binding (REV-1, design §6): what the user reviewed, and the checks that make a commit refuse when the
// worktree or HEAD is no longer what was reviewed.
import { createHash } from "node:crypto";
import type { CommitInput, WorktreeRef } from "@axis/git-ops";
import { escapeForDisplay } from "./display.js";
import { conflict, denied, internal, invalid, mapUnexpected, unavailable } from "./errors.js";
import { OBJECT_ID, expectComplete, expectOk, gitPaths, reviewGitFor, type ReviewGit } from "./gitcall.js";
import { resolveLimits } from "./limits.js";
import { snapshotWorktree } from "./snapshot.js";
import { acquireIndex } from "./tempindex.js";
import type { ReviewDeps } from "./types.js";

export interface AcceptedFile {
  readonly path: string;
  readonly oldPath?: string;
  readonly status: string;
  readonly partial: boolean;
  readonly hunks: readonly number[];
}

export interface BindingInit {
  readonly worktree: WorktreeRef;
  readonly head: string;
  /** The checked-out branch ref at review time (`refs/heads/...`), or null when HEAD was detached. */
  readonly branch: string | null;
  readonly headTree: string;
  readonly worktreeTree: string;
  readonly reviewedTree: string;
  readonly accepted: readonly AcceptedFile[];
}

/** Bindings this module created. A plain object, or an object with this prototype, is not one. */
const minted = new WeakSet<object>();
const TOKEN = Symbol("axis.review.binding");

/**
 * What was reviewed: the worktree tree the user looked at (`worktreeTree`), the HEAD it was reviewed against, and the
 * tree that will be committed (`reviewedTree`). Immutable, and only `ReviewSession.build()` can make one.
 */
export class ReviewBinding {
  readonly worktree: Readonly<WorktreeRef>;
  readonly head: string;
  readonly branch: string | null;
  readonly headTree: string;
  readonly worktreeTree: string;
  readonly reviewedTree: string;
  readonly accepted: readonly AcceptedFile[];
  /** SHA-256 over every field above: what the audit event records. */
  readonly digest: string;

  constructor(token: symbol, init: BindingInit) {
    if (token !== TOKEN) throw invalid("a review binding is created by a review session only");
    this.worktree = Object.freeze({ workTree: init.worktree.workTree, gitDir: init.worktree.gitDir });
    this.head = init.head;
    this.branch = init.branch;
    this.headTree = init.headTree;
    this.worktreeTree = init.worktreeTree;
    this.reviewedTree = init.reviewedTree;
    this.accepted = Object.freeze(init.accepted.map((a) => Object.freeze({ ...a, hunks: Object.freeze([...a.hunks]) })));
    this.digest = createHash("sha256")
      .update(JSON.stringify(["axis.review/1", this.worktree, this.head, this.branch, this.headTree, this.worktreeTree, this.reviewedTree, this.accepted]))
      .digest("hex");
    Object.freeze(this);
    minted.add(this);
  }
}

/** Package-internal: the only way to a binding. Not exported from the package index. */
export function mintBinding(init: BindingInit): ReviewBinding {
  return new ReviewBinding(TOKEN, init);
}

export function assertBinding(b: unknown): asserts b is ReviewBinding {
  if (typeof b !== "object" || b === null || !minted.has(b)) throw invalid("not a review binding");
  const r = (b as ReviewBinding).reviewedTree;
  if (!OBJECT_ID.test(r)) throw invalid("the binding holds no reviewed tree");
}

export type Freshness =
  | { readonly fresh: true }
  | { readonly fresh: false; readonly reason: "head_moved" | "stale"; readonly changedPaths: readonly string[]; readonly changedCount: number };

export interface HeadState {
  readonly commit: string;
  readonly branch: string | null;
}

/** The commit HEAD points at and the branch it is on (null when detached). */
export async function headState(git: ReviewGit): Promise<HeadState> {
  const r = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"]);
  const commit = r.stdout.trim();
  if (r.code !== 0 || !OBJECT_ID.test(commit)) throw denied("the branch has no commit to build on", "no_head");
  const b = await git(["symbolic-ref", "--quiet", "HEAD"]);
  const ref = b.stdout.trim();
  return { commit, branch: b.code === 0 && ref.startsWith("refs/heads/") ? ref : null };
}

/**
 * Whether the worktree and HEAD are still what was reviewed. The worktree is read again through git (design §2), so a file
 * edited, deleted, added or swapped for a symlink since the review makes the tree differ. The paths that differ are
 * returned, escaped, for the dialog (bounded; the count is exact up to the diff output limit).
 */
export async function checkFresh(deps: ReviewDeps, binding: ReviewBinding): Promise<Freshness> {
  return mapUnexpected(async () => {
    assertBinding(binding);
    const limits = resolveLimits(deps.limits);
    const git = await reviewGitFor(deps, binding.worktree);
    const now0 = await headState(git);
    if (now0.commit !== binding.head || now0.branch !== binding.branch) return { fresh: false, reason: "head_moved", changedPaths: [], changedCount: 0 };
    const now = await snapshotWorktree(deps, git, binding.headTree);
    if (now === binding.worktreeTree) return { fresh: true };
    const r = await git(["diff-tree", "-r", "-z", "--name-only", "--no-renames", "--no-ext-diff", "--no-textconv", binding.worktreeTree, now]);
    if (r.code !== 0) throw unavailable("could not compare the worktree with the reviewed state");
    const names = r.stdout.split("\0").filter((n) => n !== "");
    return {
      fresh: false,
      reason: "stale",
      changedCount: names.length,
      changedPaths: names.slice(0, limits.maxStalePaths).map((n) => escapeForDisplay(n, { maxLength: limits.maxDisplay, cut: "middle" })),
    };
  });
}

/**
 * What git-ops' `CommitInput` carries for a bound commit (design §6, G3): the commit the review was made on (a full object id)
 * and the branch it was checked out as, in git-ops' form: the short name (`axis/<slug>`, not `refs/heads/axis/<slug>`). Both are
 * required: `prepareCommit` refuses a detached HEAD or an unborn branch itself, so there is always a branch to name.
 */
export interface PinnedCommitInput extends CommitInput {
  readonly expectedParent: string;
  readonly expectedBranch: string;
}

export interface PreparedCommit {
  readonly worktree: WorktreeRef;
  readonly reviewedTreeHash: string;
  readonly head: string;
  /**
   * The input @axis/git-ops `planCommit` and `executeCommit` take. Call it immediately before handing over: it checks again
   * that HEAD and the branch are still what was prepared and that no operation started, and refuses (`E_CONFLICT`,
   * `head_moved` or `operation_in_progress`) when not. It does not close the last gap (design §6, G2/G3): git-ops must check
   * `expectedParent`. (`index_changed` is no longer produced: the real index is not part of the commit, ADR 0011 S1.)
   */
  handoff(message: string, author?: { readonly name: string; readonly email: string }): Promise<PinnedCommitInput>;
}

/** Git-directory entries that mean an operation is half done: committing the index now would finish it wrongly. */
const IN_PROGRESS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG", "BISECT_START"] as const;

/**
 * Refuses (E_CONFLICT `operation_in_progress`) while a merge, cherry-pick, revert, rebase, am or bisect is under way, or the
 * index has unmerged entries. Committing the reviewed tree now would record it in the middle of the operation, and the user's
 * own finish of it would then build on a commit it did not expect (design §6).
 */
async function assertNoOperation(deps: ReviewDeps, git: ReviewGit, w: WorktreeRef): Promise<void> {
  const unmerged = await git(["ls-files", "-u", "-z"]);
  if (unmerged.code !== 0) throw unavailable("could not read the index");
  if (unmerged.stdout !== "" || unmerged.truncated === true) throw conflict("the index has unmerged paths; finish or abort the operation first", "operation_in_progress");
  for (const abs of await gitPaths(deps, git, w, IN_PROGRESS)) {
    if (await deps.fileExists(abs)) throw conflict("a merge, cherry-pick, revert, rebase or bisect is in progress; finish or abort it first", "operation_in_progress");
  }
}

/**
 * Checks that the reviewed tree can be committed and returns what `executeCommit` needs. Refuses (E_CONFLICT) when HEAD moved
 * or any file changed since the review. Run under the daemon's worktree lock and before `executeCommit` (design §6: G1 to
 * G3). **It writes no user state** (DC-0, ADR 0011 S1): the reviewed tree is read into a PRIVATE index in the daemon's
 * scratch directory and written back to prove it loads whole; the real `.git/index`, the worktree and the refs are never
 * touched, so the user's own `git add` staging survives a commit and every refusal.
 */
export function prepareCommit(deps: ReviewDeps, binding: ReviewBinding): Promise<PreparedCommit> {
  return mapUnexpected(async () => {
    assertBinding(binding);
    // Nothing is handed over for a detached HEAD: git-ops commits on a branch only, and a refusal here comes before any git call.
    // (An unborn branch never gets a binding: `headState` refuses it with `no_head`.)
    if (binding.branch === null) throw denied("HEAD is detached; commit from a branch", "detached_head");
    const git = await reviewGitFor(deps, binding.worktree);
    // A sparse checkout is not supported (design §14, revisited for DC-0): the review's snapshot reads the worktree into a
    // private index with sparse checkout off, so a file outside the cone would look deleted and be committed as deleted.
    const sparse = await git(["config", "--type=bool", "--get", "core.sparseCheckout"]);
    if (sparse.code === 0 && sparse.stdout.trim() === "true") throw unavailable("a sparse checkout cannot be committed from a review");
    await assertNoOperation(deps, git, binding.worktree);
    const fresh = await checkFresh(deps, binding);
    if (!fresh.fresh) {
      throw conflict(
        fresh.reason === "head_moved" ? "HEAD or the branch moved since the review; review the changes again" : "files changed since the review; review the changes again",
        fresh.reason,
        { changedCount: fresh.changedCount },
      );
    }
    // A self-check, not a gate: it proves the reviewed tree loads whole, which git-ops' `rev-parse --verify <id>^{tree}` and
    // `commit-tree` prove again. It uses a PRIVATE index only, so the real index is never read or written here.
    const idx = await acquireIndex(deps.tempIndex);
    try {
      expectOk(await git(["read-tree", binding.reviewedTree], { index: idx.path }), "load the reviewed tree");
      const written = expectComplete(await git(["write-tree"], { index: idx.path }), "read back the reviewed tree").trim();
      if (written !== binding.reviewedTree) throw internal("the reviewed tree does not read back whole");
    } finally {
      await idx.release();
    }
    await assertNoOperation(deps, git, binding.worktree);
    const headNow = await headState(git);
    if (headNow.commit !== binding.head || headNow.branch !== binding.branch) throw conflict("HEAD or the branch moved since the review; review the changes again", "head_moved");
    const branch = binding.branch.slice("refs/heads/".length);
    return {
      worktree: binding.worktree,
      reviewedTreeHash: binding.reviewedTree,
      head: binding.head,
      handoff: (message, author) =>
        mapUnexpected(async () => {
          const g = await reviewGitFor(deps, binding.worktree);
          const now = await headState(g);
          if (now.commit !== binding.head || now.branch !== binding.branch) throw conflict("HEAD or the branch moved since the review was prepared; review the changes again", "head_moved");
          await assertNoOperation(deps, g, binding.worktree);
          return {
            worktree: binding.worktree,
            reviewedTreeHash: binding.reviewedTree,
            message,
            ...(author === undefined ? {} : { author }),
            expectedParent: binding.head,
            expectedBranch: branch,
          };
        }),
    };
  });
}
