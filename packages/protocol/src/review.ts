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
 * `E_INVALID_ARGUMENT`, `reason: "too_large"`) instead of being listed in part, so what the user reviews is all of what is committed.
 */
export const MAX_REVIEW_FILES = 200;
export const MAX_REVIEW_PATH = 256;
/** Files left out of the snapshot for their size: listed (up to this many) so they are not silently missing. */
export const MAX_REVIEW_SKIPPED = 50;
const MAX_FILE_TAGS = 4;

/**
 * `details.reason` values `diff` can answer with, by error code: what `@axis/review` raises on the path the host runs
 * (`ReviewSession.start`, `hasCutLines`, `acceptFile`, `build`). Closed set; never free text. `unsafe_path`, `filtered_path`,
 * `truncated_hunk` and `nothing_accepted` are refusals of `build()` that a handler following the rules below never
 * triggers (it does not build such a review and answers `treeHash: null`), but a handler bug would, so they are on the
 * wire. Not on this wire: `not_a_commit` and `no_hunks` (no `against`, no hunk API), and the commit-side reasons
 * (`head_moved`, `stale`, `index_changed`, `operation_in_progress`, `detached_head`), which are `axis.git/1.commit`'s.
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

/*
 * Copies of `ChangeStatus` and `ChangeKind` in `@axis/review` (types only, so no runtime check is possible);
 * `packages/review/test/types/wire-shape.test.ts` compares them at compile time. Change both together.
 */
export const CHANGE_STATUS_VALUES = ["A", "M", "D", "R", "T"] as const;
export const CHANGE_KIND_VALUES = ["text", "binary", "symlink", "submodule", "too-large", "filtered"] as const;
export const changeStatusSchema = z.enum(CHANGE_STATUS_VALUES);
export const changeKindSchema = z.enum(CHANGE_KIND_VALUES);

/**
 * Names a file within one review. Minted by the host: the SHA-256, in lower-case hex, of the raw repository path bytes
 * (`ReviewFile.path`), never of the display string. Unique within a response; two files can show the same
 * `displayPath` (a cut in the middle of long paths) but never the same `fileId`. It is an identity, not a secret.
 */
export const fileIdSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * The content binding of an acknowledgement: the object id of the exact content the user is told is cut and the commit
 * holds, taken from the same snapshot tree the `treeHash` is built from (the `newOid` of the file in that tree; for a symlink
 * the blob of its target). Only a `truncated` file has one.
 */
export const contentIdSchema = objectIdSchema;

/** One acknowledgement: this file, with exactly this content. Both must equal the current entry, byte for byte (no case folding, no normalisation). */
export const acknowledgementSchema = z.strictObject({ fileId: fileIdSchema, contentId: contentIdSchema });
export type Acknowledgement = z.infer<typeof acknowledgementSchema>;

/**
 * Whether the request's acknowledgements cover this file of the CURRENT review. True only for a truncated file whose
 * `fileId` AND `contentId` both equal an acknowledgement's, as exact strings (no case folding, no normalisation). The handler
 * decides `acceptTruncated` and `acknowledged` with this and nothing else, so a changed file, a moved file or a replayed
 * list acknowledges nothing.
 */
export function isAcknowledged(
  file: { readonly fileId: string; readonly truncated: boolean; readonly contentId: string | null },
  acknowledged: readonly Acknowledgement[] | undefined,
): boolean {
  if (!file.truncated || file.contentId === null || acknowledged === undefined) return false;
  return acknowledged.some((a) => a.fileId === file.fileId && a.contentId === file.contentId);
}

const tag = (max: number) => z.array(displayTextSchema(64)).max(max);

/** One changed file, as `ReviewFile` in `@axis/review` minus the raw paths, object ids and modes. */
export const reviewFileSchema = z
  .strictObject({
  fileId: fileIdSchema,
  /** For display only: `toDisplayPath(path, MAX_REVIEW_PATH)`. Not unique, not an identity. */
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
  /**
   * Accepting this file would accept text the view cuts off (a line longer than the view, or a symlink target that was cut):
   * `hasCutLines` in `@axis/review`. It needs the user's acknowledgement before a `treeHash` is returned.
   */
  truncated: z.boolean(),
  /** Set exactly when `truncated`: what an acknowledgement of this file must name (`contentIdSchema`). */
  contentId: contentIdSchema.nullable(),
  /** The request acknowledged this `fileId` AND this `contentId`, and both equal this entry's. Never true for a file that is not truncated. */
  acknowledged: z.boolean(),
  /** WT-3: names of the protected-path rules that matched. */
  protectedRules: tag(MAX_FILE_TAGS),
  /** Why only a whole-file decision is offered, when hunks are not. */
  fileLevelReason: displayTextSchema(128).optional(),
  /** Short labels such as `symlink-outside` or `binary`. */
  warnings: tag(MAX_FILE_TAGS),
  })
  .refine((f) => !f.acknowledged || f.truncated, "only a truncated file can be acknowledged")
  .refine((f) => f.truncated === (f.contentId !== null), "a truncated file, and only a truncated file, has a content id");
export type ReviewFileWire = z.infer<typeof reviewFileSchema>;

/** `SkippedFile` in `@axis/review`. */
export const skippedFileSchema = z.strictObject({
  displayPath: displayTextSchema(MAX_REVIEW_PATH),
  size: countSchema,
  reason: z.literal("too_large_to_review"),
});

// diff (read, tier 1): reads the worktree into a tree object; changes nothing the user can see.
export const reviewDiffRequestSchema = guarded(
  z.strictObject({
    workspaceId: workspaceIdSchema,
    /**
     * The files the user explicitly acknowledged (REV-1): each `{ fileId, contentId }` as a previous response gave it. The
     * handler passes `acceptTruncated` to `@axis/review` for a file ONLY when its `fileId` and its `contentId` both equal
     * the entry of THIS review (exact string equality), `hasCutLines` is true for it, and the content id was computed from
     * the same snapshot tree the `treeHash` is built from, in the same read. A pair that matches no truncated entry (the
     * file changed, moved, or was never cut) acknowledges nothing and is not echoed. Unique by `fileId`, at most 200.
     */
    acknowledged: z
      .array(acknowledgementSchema)
      .max(MAX_REVIEW_FILES)
      .refine((a) => new Set(a.map((x) => x.fileId)).size === a.length, "duplicate file id")
      .optional(),
  }),
);
export const reviewDiffResponseSchema = guarded(
  z
    .strictObject({
    /** The commit the review is against: HEAD. It is `expectedParent` of the commit. */
    head: objectIdSchema,
    /** The checked-out branch in the short form, or null when HEAD is detached (nothing can be committed). */
    branch: axisBranchSchema.nullable(),
    /**
     * The tree that a commit of everything listed would hold (`reviewedTree` of the binding): the `reviewedTreeHash` of
     * the commit. Null, and the schema enforces it, whenever the review cannot be committed as a whole: no file, HEAD
     * detached, a file with an unusable path or a content filter (`unsafePath`, kind `filtered`), or a `truncated` file the
     * user has not acknowledged. The wire carries no content, only bounded lines the view may cut, so a tree is never
     * returned for text the user was not shown unless they acknowledged that per file (the 1a review is bounded-line review).
     */
    treeHash: objectIdSchema.nullable(),
    files: z.array(reviewFileSchema).max(MAX_REVIEW_FILES),
    skipped: z.array(skippedFileSchema).max(MAX_REVIEW_SKIPPED),
    /** All files left out of the snapshot for their size; `skipped` lists the first. */
    skippedCount: countSchema,
  })
    .refine((r) => r.treeHash === null || r.branch !== null, "a tree needs a branch")
    .refine((r) => r.treeHash === null || r.files.length > 0, "a tree needs a change")
    .refine((r) => r.treeHash === null || !r.files.some((f) => f.unsafePath || f.kind === "filtered"), "a tree needs committable files")
    .refine((r) => r.treeHash === null || !r.files.some((f) => f.truncated && !f.acknowledged), "a tree needs every cut file acknowledged")
    .refine((r) => new Set(r.files.map((f) => f.fileId)).size === r.files.length, "duplicate file id")
    .refine((r) => r.skippedCount >= r.skipped.length && r.skipped.length === Math.min(r.skippedCount, MAX_REVIEW_SKIPPED), "skipped list does not match its count"),
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
