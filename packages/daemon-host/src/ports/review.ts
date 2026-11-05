// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { PortContext } from "./common.js";

/**
 * The review port: a review of one workspace, opened by id (the implementation resolves the path itself). It is
 * deliberately free of `@axis/review` types (only `src/bindings/review.ts` may import that package): the handler sees
 * plain facts about the snapshot and an opaque handle for the reviewed tree.
 *
 * Everything in a `ReviewRound` comes from ONE read of the worktree (the snapshot the `reviewedTree` is built from), so
 * the mode and object id a handler turns into a `contentId` are the entries of that same tree.
 */
export const REVIEW_CHANGE_STATUSES = ["A", "M", "D", "R", "T"] as const;
export const REVIEW_CHANGE_KINDS = ["text", "binary", "symlink", "submodule", "too-large", "filtered"] as const;

export interface RoundFile {
  /** Repository-relative, as git has it and as the host decoded it. Never put on the wire; use for ids and operations. */
  readonly path: string;
  readonly oldPath?: string;
  readonly status: (typeof REVIEW_CHANGE_STATUSES)[number];
  readonly kind: (typeof REVIEW_CHANGE_KINDS)[number];
  /** The file's mode and object id in the snapshot tree. */
  readonly newMode: string;
  readonly newOid: string;
  readonly similarity?: number;
  readonly additions?: number;
  readonly deletions?: number;
  /** The review itself judged the path unusable (it cannot be accepted). */
  readonly unsafePath: boolean;
  readonly protectedRules: readonly string[];
  readonly fileLevelReason?: string;
  readonly warnings: readonly string[];
}

export interface RoundSkipped {
  readonly path: string;
  readonly size: number;
}

/** Opaque: what the git handler hands back to its own binding (`prepareCommit`). Nothing in the host reads inside it. */
declare const handleBrand: unique symbol;
export interface ReviewHandle {
  readonly [handleBrand]: true;
}

export interface BuiltTree {
  /** The tree a commit of everything accepted would hold. */
  readonly reviewedTree: string;
  /** The commit the review was built against: the `expectedParent` of the commit. */
  readonly head: string;
  /** The short branch name (`axis/<slug>`), never null here. */
  readonly branch: string;
  readonly handle: ReviewHandle;
}

export interface ReviewRound {
  /** The commit HEAD pointed at when the round opened. */
  readonly head: string;
  /** The checked-out branch in the short form, or null when HEAD is detached. */
  readonly branch: string | null;
  readonly files: readonly RoundFile[];
  readonly skipped: readonly RoundSkipped[];
  readonly skippedCount: number;
  /** Whether accepting this file whole would accept text the view cuts (`hasCutLines`). */
  hasCutLines(path: string): Promise<boolean>;
  /** Accepts a whole file. `acceptTruncated` only for a file the user acknowledged. */
  accept(path: string, options: { readonly acceptTruncated: boolean }): void;
  /** Builds the reviewed tree from what was accepted. Refuses (`ReviewRefusal`) for anything the review would not commit. */
  build(): Promise<BuiltTree>;
}

/** The failure of a review, as plain data: an error code of the closed set and an optional closed `reason`. */
export class ReviewRefusal extends Error {
  constructor(
    readonly code: string,
    readonly reason?: string,
  ) {
    super("review refused");
    this.name = "ReviewRefusal";
  }
}

export interface ReviewService {
  /** Rejects `ReviewRefusal` (or `E_NOT_FOUND` from the locator) and never with a message that holds a path. */
  open(workspaceId: string, ctx: PortContext): Promise<ReviewRound>;
}
