// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";

/**
 * `details.reason` values `diff` can answer with, by error code: what `@axis/review` raises on the path the host runs
 * (`ReviewSession.start`, `hasCutLines`, `acceptFile`, `build`). Closed set; never free text. `unsafe_path`, `filtered_path`,
 * `truncated_hunk` and `nothing_accepted` are refusals of `build()` that a handler following the rules below never
 * triggers (it does not build such a review and answers `treeHash: null`), but a handler bug would, so they are on the
 * wire. Not on this wire: `not_a_commit` (no `against`), `no_hunks` (a `build` reason, `review-hunks.ts`), and the commit-side reasons
 * (`head_moved`, `stale`, `index_changed` (retired, no longer produced), `operation_in_progress`, `detached_head`), which are `axis.git/1.commit`'s.
 */
export const REVIEW_DIFF_REFUSALS = {
  /** `too_large`: more files than the review holds (see `MAX_REVIEW_FILES`), or git output cut off. `not_found`: HEAD is gone. */
  E_INVALID_ARGUMENT: ["too_large", "not_found"],
  E_CONFLICT: ["snapshot_failed", "hunks_do_not_apply", "index_refused", "path_conflict", "not_head"],
  E_POLICY_DENIED: ["no_head", "unsafe_path", "filtered_path", "nothing_accepted", "truncated_hunk"],
} as const;
export const REVIEW_DIFF_REASONS = [
  ...REVIEW_DIFF_REFUSALS.E_INVALID_ARGUMENT,
  ...REVIEW_DIFF_REFUSALS.E_CONFLICT,
  ...REVIEW_DIFF_REFUSALS.E_POLICY_DENIED,
] as const;
export const reviewDiffReasonSchema = z.enum(REVIEW_DIFF_REASONS);
