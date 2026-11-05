// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// A review: the changed files of one worktree against HEAD or a recorded base, hunks on demand, accept and reject per
// file and per hunk, and the reviewed tree (design §2 to §6). State is in memory; the binding is what leaves.
import type { WorktreeRef } from "@axis/git-ops";
import { headState, mintBinding, type ReviewBinding } from "./binding.js";
import { buildReviewedTree, type FileDecision } from "./build.js";
import { listChanges } from "./changes.js";
import { conflict, denied, internal, invalid, mapUnexpected, notFound } from "./errors.js";
import { assertOid, expectComplete, objectSize, reviewGitFor, resolveObject, type ReviewGit } from "./gitcall.js";
import { applyHunks, blobOid, hunkId, parseUnifiedHunks, type Hunk } from "./hunks.js";
import { resolveLimits } from "./limits.js";
import { hunkTruncated, hunkView, previewSide, textCut, type HunkView, type Preview } from "./preview.js";
import { snapshotWorktreeDetailed } from "./snapshot.js";
import type { ReviewDeps, ReviewFile, ReviewInput, ReviewLimits, SkippedFile } from "./types.js";

export type FileDecisionState = "none" | "accepted" | "partial";

export interface FileHunks {
  readonly path: string;
  readonly displayPath: string;
  /** Present when hunks can be offered. */
  readonly hunks?: readonly HunkView[];
  /** Present when only a whole-file decision is offered, and why. */
  readonly fileLevelReason?: string;
}

type Loaded = { readonly kind: "hunks"; readonly hunks: readonly Hunk[] } | { readonly kind: "file-level"; readonly reason: string };

export class ReviewSession {
  readonly worktree: WorktreeRef;
  /** The commit the review is against, and its tree. */
  readonly against: string;
  readonly againstTree: string;
  /** The worktree as it was read once, at the start (design §2). */
  readonly worktreeTree: string;
  readonly files: readonly ReviewFile[];
  /** Files over the snapshot size cap: left out of the review, listed here so they are not silently missing. */
  readonly skipped: readonly SkippedFile[];
  readonly skippedCount: number;

  readonly #deps: ReviewDeps;
  readonly #limits: ReviewLimits;
  readonly #git: ReviewGit;
  readonly #byPath: Map<string, ReviewFile>;
  readonly #loaded = new Map<string, Loaded>();
  readonly #inflight = new Map<string, Promise<Loaded>>();
  /** `ack`: the user acknowledged text the view cut in a whole-file accept; `acked`: the hunks acknowledged one by one (see `acceptTruncated`). */
  readonly #decisions = new Map<string, { whole: boolean; hunks: Set<number>; ack: boolean; acked: Set<number> }>();
  #cached = 0;

  private constructor(deps: ReviewDeps, limits: ReviewLimits, git: ReviewGit, input: ReviewInput, againstTree: string, snap: { tree: string; skipped: readonly SkippedFile[]; skippedCount: number }, files: readonly ReviewFile[]) {
    this.#deps = deps;
    this.#limits = limits;
    this.#git = git;
    this.worktree = { workTree: input.worktree.workTree, gitDir: input.worktree.gitDir };
    this.against = input.against;
    this.againstTree = againstTree;
    this.worktreeTree = snap.tree;
    this.skipped = Object.freeze(snap.skipped.slice());
    this.skippedCount = snap.skippedCount;
    this.files = Object.freeze(files.slice());
    this.#byPath = new Map(files.map((f) => [f.path, f]));
  }

  /** Reads the worktree once and lists what changed against `input.against`. Throws `too_large` for an incomplete list. */
  static start(deps: ReviewDeps, input: ReviewInput): Promise<ReviewSession> {
    return mapUnexpected(async () => {
      const limits = resolveLimits(deps.limits);
      const against = assertOid(input.against, "against");
      const git = await reviewGitFor(deps, input.worktree);
      if ((await resolveObject(git, against, "commit")) !== against) throw invalid("against must be a commit id", "not_a_commit");
      const againstTree = await resolveObject(git, against, "tree");
      const snap = await snapshotWorktreeDetailed(deps, git, againstTree);
      const files = await listChanges(deps, input.worktree, git, againstTree, snap.tree, limits, deps.protectedPaths);
      return new ReviewSession(deps, limits, git, input, againstTree, snap, files);
    });
  }

  file(path: string): ReviewFile {
    const f = this.#byPath.get(path);
    if (!f) throw notFound("that file is not part of this review");
    return f;
  }

  /** The hunks of one text file, or why only a whole-file decision is offered. Cached; bounded in total. */
  hunks(path: string): Promise<FileHunks> {
    return mapUnexpected(async () => {
      const f = this.file(path);
      const loaded = await this.#load(f);
      return {
        path: f.path,
        displayPath: f.displayPath,
        ...(loaded.kind === "hunks" ? { hunks: loaded.hunks.map((h) => hunkView(h, this.#limits)) } : { fileLevelReason: loaded.reason }),
      };
    });
  }

  #load(f: ReviewFile): Promise<Loaded> {
    const have = this.#loaded.get(f.path);
    if (have) return Promise.resolve(have);
    // One load per path at a time, so the cache is charged once however many callers ask.
    const running = this.#inflight.get(f.path);
    if (running) return running;
    const p = this.#loadUncached(f)
      .then((result) => {
        this.#loaded.set(f.path, result);
        return result;
      })
      .finally(() => this.#inflight.delete(f.path));
    this.#inflight.set(f.path, p);
    return p;
  }

  async #loadUncached(f: ReviewFile): Promise<Loaded> {
    const fileLevel = (reason: string): Loaded => ({ kind: "file-level", reason });
    if (f.fileLevelReason !== undefined) return fileLevel(f.fileLevelReason);
    const git = this.#git;
    const sizes = await Promise.all([f.oldOid, f.newOid].map((oid) => objectSize(git, oid)));
    if (sizes.some((s) => s === undefined)) return fileLevel("unreadable");
    if (Math.max(...(sizes as number[])) > this.#limits.maxHunkFileBytes) return fileLevel("too_large");
    // Every setting that changes what a diff looks like is pinned, so a repository's config cannot switch per-hunk review off
    // (diff.suppressBlankEmpty turns a blank context line into an empty one, which the parser rightly refuses).
    const r = await git([
      "-c", "diff.suppressBlankEmpty=false", "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.interHunkContext=0",
      "-c", "diff.context=3", "-c", "core.bigFileThreshold=2g",
      "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--inter-hunk-context=0", "-U3", f.oldOid, f.newOid,
    ]);
    if (r.code !== 0) return fileLevel("diff_failed");
    if (r.truncated === true || r.stdout.length > this.#limits.maxPatchBytes) return fileLevel("patch_too_large");
    // The cache is charged before the patch is kept, so the bound holds even when the next file would exceed it.
    this.#cached += r.stdout.length;
    if (this.#cached > this.#limits.maxCachedPatchBytes) {
      this.#cached -= r.stdout.length;
      throw invalid("too many diffs are open in this review", "too_large");
    }
    const parsed = parseUnifiedHunks(r.stdout, this.#limits.maxHunksPerFile);
    if (!parsed.ok) return fileLevel(parsed.reason);
    if (parsed.hunks.length === 0) return fileLevel("no_content_change");
    // The proof that makes a partial accept safe: all hunks together must rebuild the new file exactly (design §4).
    const oldText = expectComplete(await git(["cat-file", "blob", f.oldOid]), "read a file version");
    const all = applyHunks(oldText, parsed.hunks, new Set(parsed.hunks.map((h) => h.index)));
    if (all === null || blobOid(all, f.newOid.length) !== f.newOid) return fileLevel("not_reproducible");
    return { kind: "hunks", hunks: parsed.hunks };
  }

  preview(path: string, side: "old" | "new"): Promise<Preview> {
    return mapUnexpected(() => previewSide(this.#git, this.file(path), side, this.#limits));
  }

  #acceptable(path: string): ReviewFile {
    const f = this.file(path);
    if (f.unsafePath) throw denied("a file with an unusable path cannot be accepted", "unsafe_path");
    if (f.kind === "filtered") throw denied("a file with a content filter (git-crypt, LFS and the like) cannot be accepted here", "filtered_path");
    return f;
  }

  /** Accepts everything about a file: content, mode, rename, delete, type. */
  acceptFile(path: string, opts: { readonly acceptTruncated?: boolean } = {}): void {
    this.#acceptable(path);
    this.#decisions.set(path, { whole: true, hunks: new Set(), ack: opts.acceptTruncated === true, acked: new Set() });
  }

  /** Takes a file back out of the review's accepted set (and every hunk of it). */
  rejectFile(path: string): void {
    this.file(path);
    this.#decisions.delete(path);
  }

  #hunkIndex(path: string, id: string): { hunks: readonly Hunk[]; index: number } {
    const loaded = this.#loaded.get(path);
    if (!loaded || loaded.kind !== "hunks") throw invalid("load the hunks of this file first, and only a file with hunks has them", "no_hunks");
    const h = loaded.hunks.find((x) => hunkId(x) === id);
    if (!h) throw notFound("that hunk is not part of this review");
    return { hunks: loaded.hunks, index: h.index };
  }

  /**
   * Accepts one hunk. A hunk with a line the view had to cut is refused unless the caller passes `acceptTruncated: true`,
   * which is the user's explicit acknowledgement that part of an added or removed line was not shown.
   */
  acceptHunk(path: string, id: string, opts: { readonly acceptTruncated?: boolean } = {}): void {
    this.#acceptable(path);
    const { hunks, index } = this.#hunkIndex(path, id);
    const hunk = hunks[index];
    if (hunk && opts.acceptTruncated !== true && hunkTruncated(hunk, this.#limits)) {
      throw denied("a line of this hunk is longer than the view shows; accept it only after acknowledging that", "truncated_hunk");
    }
    const cur = this.#decisions.get(path) ?? { whole: false, hunks: new Set<number>(), ack: false, acked: new Set<number>() };
    if (cur.whole) return;
    cur.hunks.add(index);
    if (opts.acceptTruncated === true) cur.acked.add(index);
    // Every hunk accepted is the whole file, mode and rename included (design §5). Each hunk passed the cut-line gate above.
    this.#decisions.set(path, cur.hunks.size === hunks.length ? { whole: true, hunks: new Set(), ack: true, acked: new Set() } : cur);
  }

  rejectHunk(path: string, id: string): void {
    this.file(path);
    const { hunks, index } = this.#hunkIndex(path, id);
    const cur = this.#decisions.get(path);
    if (!cur) return;
    const rest = cur.whole ? new Set(hunks.map((h) => h.index)) : cur.hunks;
    rest.delete(index);
    if (rest.size === 0) this.#decisions.delete(path);
    // What was acknowledged for the whole file stays acknowledged for the hunks that remain; nothing else is.
    else this.#decisions.set(path, { whole: false, hunks: rest, ack: false, acked: cur.whole ? (cur.ack ? new Set(rest) : new Set()) : cur.acked });
  }

  /**
   * Whether accepting this file whole would accept text the view cuts: a line of its added or removed text (an added file's
   * whole text) longer than the view shows. `acceptFile` records an acknowledgement; `build` refuses the file without one.
   */
  async hasCutLines(path: string): Promise<boolean> {
    return mapUnexpected(async () => {
      const f = this.file(path);
      // Decided from what the NEW side would hold, whatever the old side or the kind was (a symlink that becomes a file, a file
      // that becomes a link, a binary that becomes text).
      if (f.status === "D" || f.unsafePath || f.kind === "filtered" || f.kind === "submodule" || f.newMode === "160000") return false;
      if (f.newMode === "120000") return f.link?.targetCut === true;
      if (f.oldOid === f.newOid) return false;
      const loaded = await this.#load(f);
      if (loaded.kind === "hunks") return loaded.hunks.some((h) => hunkTruncated(h, this.#limits));
      const size = await objectSize(this.#git, f.newOid);
      if (size === undefined || size > this.#limits.maxPreviewBytes) return false;
      const body = expectComplete(await this.#git(["cat-file", "blob", f.newOid]), "read a file version");
      return !body.includes("\0") && textCut(body, this.#limits);
    });
  }

  async #partialHasUnackedCut(path: string, chosen: ReadonlySet<number>, acked: ReadonlySet<number>): Promise<boolean> {
    const loaded = this.#loaded.get(path);
    // A partial decision exists only for a file whose hunks were loaded; if not, it is refused here rather than trusted.
    if (loaded?.kind !== "hunks") return true;
    return loaded.hunks.some((h) => chosen.has(h.index) && !acked.has(h.index) && hunkTruncated(h, this.#limits));
  }

  reset(): void {
    this.#decisions.clear();
  }

  decision(path: string): { state: FileDecisionState; hunks: readonly string[] } {
    this.file(path);
    const d = this.#decisions.get(path);
    if (!d) return { state: "none", hunks: [] };
    if (d.whole) return { state: "accepted", hunks: [] };
    const loaded = this.#loaded.get(path);
    const ids = loaded?.kind === "hunks" ? loaded.hunks.filter((h) => d.hunks.has(h.index)).map(hunkId) : [];
    return { state: "partial", hunks: ids };
  }

  /**
   * Builds the reviewed tree from the decisions as they are now (a later decision does not affect this call) and returns the
   * binding. Requires HEAD to be the commit the review is against: a review against an older base is for looking, not for
   * committing. Objects are written; the worktree, index and refs are not touched.
   */
  build(): Promise<ReviewBinding> {
    return mapUnexpected(async () => {
      const decisions = new Map<string, FileDecision>();
      // Copied first: a decision made while this build awaits must not change it.
      // The one place every accepted byte passes, however the decision was assembled: a whole file, or each hunk of a partial one.
      for (const [p, d] of [...this.#decisions].map(([k, v]) => [k, { ...v, hunks: new Set(v.hunks), acked: new Set(v.acked) }] as const)) {
        decisions.set(p, { whole: d.whole, hunks: new Set(d.hunks) });
        const cut = d.whole ? !d.ack && (await this.hasCutLines(p)) : await this.#partialHasUnackedCut(p, d.hunks, d.acked);
        if (cut) throw denied("a line of an accepted file is longer than the view shows; accept it again with the acknowledgement", "truncated_hunk");
      }
      const git = await reviewGitFor(this.#deps, this.worktree);
      const headNow = await headState(git);
      if (headNow.commit !== this.against) throw conflict("the review is not against HEAD; review again against HEAD to commit", "not_head");
      const hunks = new Map<string, readonly Hunk[]>();
      for (const [p, d] of decisions) {
        const l = this.#loaded.get(p);
        if (!d.whole) {
          if (l?.kind !== "hunks") throw internal("a partial decision has no hunks");
          hunks.set(p, l.hunks);
        }
      }
      const built = await buildReviewedTree(this.#deps, git, { againstTree: this.againstTree, files: this.#byPath, hunks, decisions });
      return mintBinding({
        worktree: this.worktree,
        head: this.against,
        branch: headNow.branch,
        headTree: this.againstTree,
        worktreeTree: this.worktreeTree,
        reviewedTree: built.reviewedTree,
        accepted: built.accepted,
      });
    });
  }
}
