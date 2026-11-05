// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { PortContext } from "./common.js";

export const REVIEW_FILE_STATUSES = ["added", "modified", "deleted", "renamed"] as const;
export type ReviewFileStatus = (typeof REVIEW_FILE_STATUSES)[number];

export interface ReviewFile {
  /** Relative to the worktree root. */
  readonly path: string;
  readonly status: ReviewFileStatus;
  /** Absent for a binary file. */
  readonly additions?: number;
  readonly deletions?: number;
}

export interface ReviewDiff {
  /** The tree hash a later commit binds to (reviewed-tree binding). */
  readonly treeHash: string;
  readonly files: readonly ReviewFile[];
  /** True when patches were cut at the bounds, so the list is not complete text. */
  readonly patchesBounded: boolean;
}

/** Diff review of a workspace, by id (the implementation resolves the path itself). */
export interface ReviewService {
  diff(workspaceId: string, ctx: PortContext): Promise<ReviewDiff>;
}
