// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { cliRunSchema } from "./cliRuns.js";
import { axisBranchSchema, objectIdSchema } from "./git.js";
import { countSchema, displayTextSchema, guarded } from "./guard.js";
import { runIdSchema, workspaceIdSchema, type MethodSpec } from "./worktrees.js";

/**
 * `axis.review/1` (docs/design/daemon-host.md section 4.2). `diff` is the read side of `@axis/review`: the changed files
 * of a workspace against its HEAD, and the tree hash a later `axis.git/1.commit` is bound to (REV-1). `complete` is the
 * user's decision that a run in REVIEWING is done.
 *
 * `complete` is for the user principal only: policy admits only the `user` actor, and the daemon mints the
 * `UserPrincipal` the journal needs (`@axis/journal` refuses REVIEWING to COMPLETED for any other actor). The request
 * carries no actor. An agent or the CLI run itself cannot reach it (DMN-3).
 *
 * Neither request carries a path: the workspace id names the worktree and the host resolves it. A file is shown by its
 * escaped display path only; the raw repository path is never on the wire (it can hold control or bidi characters).
 */

export const REVIEW_CONTRACT = "axis.review" as const;
export const REVIEW_VERSION = 1 as const;

/**
 * Most files one `diff` reply lists. `@axis/review` allows 5000 (`maxFiles`), but a file is about ten values and the
 * message walk allows 10,000 and 1 MiB, so the host must construct the review with `maxFiles` and `maxDisplay` at most
 * `MAX_REVIEW_FILES` and `MAX_REVIEW_PATH`: a larger change set then fails the review itself (`E_CONFLICT`,
 * `reason: "too_large"`) instead of being listed in part, so what the user reviews is all of what is committed.
 */
export const MAX_REVIEW_FILES = 200;
export const MAX_REVIEW_PATH = 256;
/** Files left out of the snapshot for their size: listed (up to this many) so they are not silently missing. */
export const MAX_REVIEW_SKIPPED = 50;
const MAX_FILE_TAGS = 4;

/** `details.reason` values `diff` can answer with. Closed set, the names `@axis/review` raises; never free text. */
export const REVIEW_DIFF_REASONS = [
  /** The branch has no commit to review against. */
  "no_head",
  "not_a_commit",
  /** The worktree could not be read into a tree. */
  "snapshot_failed",
  /** More files than the review holds (see `MAX_REVIEW_FILES`). */
  "too_large",
] as const;
export const reviewDiffReasonSchema = z.enum(REVIEW_DIFF_REASONS);

/*
 * Copies of `ChangeStatus` and `ChangeKind` in `@axis/review` (types only, so no runtime check is possible);
 * `packages/review/test/types/wire-shape.test.ts` compares them at compile time. Change both together.
 */
export const CHANGE_STATUS_VALUES = ["A", "M", "D", "R", "T"] as const;
export const CHANGE_KIND_VALUES = ["text", "binary", "symlink", "submodule", "too-large", "filtered"] as const;
export const changeStatusSchema = z.enum(CHANGE_STATUS_VALUES);
export const changeKindSchema = z.enum(CHANGE_KIND_VALUES);

const tag = (max: number) => z.array(displayTextSchema(64)).max(max);

/** One changed file, as `ReviewFile` in `@axis/review` minus the raw paths, object ids and modes. */
export const reviewFileSchema = z.strictObject({
  displayPath: displayTextSchema(MAX_REVIEW_PATH),
  /** Set for a rename. */
  displayOldPath: displayTextSchema(MAX_REVIEW_PATH).optional(),
  status: changeStatusSchema,
  kind: changeKindSchema,
  similarity: z.number().int().min(0).max(100).optional(),
  additions: countSchema.optional(),
  deletions: countSchema.optional(),
  /** The path is not usable: the file cannot be accepted, so the review has no `treeHash`. */
  unsafePath: z.boolean(),
  /** WT-3: names of the protected-path rules that matched. */
  protectedRules: tag(MAX_FILE_TAGS),
  /** Why only a whole-file decision is offered, when hunks are not. */
  fileLevelReason: displayTextSchema(128).optional(),
  /** Short labels such as `symlink-outside` or `binary`. */
  warnings: tag(MAX_FILE_TAGS),
});
export type ReviewFileWire = z.infer<typeof reviewFileSchema>;

/** `SkippedFile` in `@axis/review`. */
export const skippedFileSchema = z.strictObject({
  displayPath: displayTextSchema(MAX_REVIEW_PATH),
  size: countSchema,
  reason: z.literal("too_large_to_review"),
});

// diff (read, tier 1): reads the worktree into a tree object; changes nothing the user can see.
export const reviewDiffRequestSchema = guarded(z.strictObject({ workspaceId: workspaceIdSchema }));
export const reviewDiffResponseSchema = guarded(
  z.strictObject({
    /** The commit the review is against: HEAD. It is `expectedParent` of the commit. */
    head: objectIdSchema,
    /** The checked-out branch in the short form, or null when HEAD is detached (nothing can be committed). */
    branch: axisBranchSchema.nullable(),
    /**
     * The tree that a commit of everything listed would hold (`reviewedTree` of the binding): the `reviewedTreeHash` of
     * the commit. Null when the review cannot be committed as a whole: a file has an unusable path or a content filter
     * (`unsafePath`, kind `filtered`), or HEAD is detached.
     */
    treeHash: objectIdSchema.nullable(),
    files: z.array(reviewFileSchema).max(MAX_REVIEW_FILES),
    skipped: z.array(skippedFileSchema).max(MAX_REVIEW_SKIPPED),
    /** All files left out of the snapshot for their size; `skipped` lists the first. */
    skippedCount: countSchema,
  }),
);

// complete (write, tier 2, idempotency required, user principal only): REVIEWING to COMPLETED.
export const reviewCompleteRequestSchema = guarded(z.strictObject({ runId: runIdSchema }));
export const reviewCompleteResponseSchema = guarded(
  z.strictObject({ run: cliRunSchema.refine((r) => r.state === "COMPLETED", "the run is not completed") }),
);

export const reviewMethods = {
  diff: {
    request: reviewDiffRequestSchema,
    response: reviewDiffResponseSchema,
    sideEffect: "read",
    tier: 1,
    idempotency: "none",
    timeoutMs: 30_000,
  },
  complete: {
    request: reviewCompleteRequestSchema,
    response: reviewCompleteResponseSchema,
    sideEffect: "write",
    tier: 2,
    idempotency: "required",
    timeoutMs: 15_000,
  },
} as const satisfies Record<string, MethodSpec>;

export type ReviewMethod = keyof typeof reviewMethods;
export type ReviewRequest<M extends ReviewMethod> = z.infer<(typeof reviewMethods)[M]["request"]>;
export type ReviewResponse<M extends ReviewMethod> = z.infer<(typeof reviewMethods)[M]["response"]>;
