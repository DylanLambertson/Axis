// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { axisBranchSchema, objectIdSchema } from "./git.js";
import { guarded } from "./guard.js";
import { inspectMessage } from "./limits.js";
import { CONTENT_LEADING_REFUSED, CONTENT_REFUSED } from "./review-content.js";
import { contentIdSchema, fileIdSchema } from "./review-ids.js";
import { REVIEW_DIFF_REASONS } from "./review-reasons.js";
import { workspaceIdSchema } from "./worktrees.js";

/**
 * `axis.review/1.hunks` and `axis.review/1.build` (ticket DC-2, docs/design/review-hunks-build.md): the hunks of one changed
 * file, and a reviewed tree built from a selection of whole files and hunks, which `axis.git/1.commit` accepts exactly as it
 * accepts a `diff` tree. Every request opens a new review round; a selection names files by `fileId` and the exact version
 * the user saw by `versionId`, and hunks by `hunkId` (meaningful only with that version).
 */

/** Hunks in one reply (`@axis/review`'s `maxHunksPerFile` is at most this). */
export const MAX_HUNKS_REPLY_HUNKS = 200;
/** Lines in one reply, all hunks together: each line is an object and four values, so the reply stays under 9,000 values. */
export const MAX_HUNKS_REPLY_LINES = 1_500;
/**
 * UTF-16 units of one line's escaped text. The host pins `maxDisplay` at 256, so the core keeps at most 1,024 code points of
 * a line, and one escaped code point is at most ten units (a six-digit escape such as `\u{10ffff}`).
 */
export const MAX_HUNK_LINE_CHARS = 10_240;
/** UTF-16 units of `text` in one reply: at most 3 UTF-8 bytes a unit, so under 400 KB, inside every string and message bound. */
export const MAX_HUNKS_REPLY_CHARS = 131_072;
/** `hunkIds` and `acknowledgedHunkIds` together, across one selection. */
export const MAX_SELECTION_HUNK_IDS = 2_000;
/** The headroom the host checks a candidate `hunks` reply against before sending it (the message walk allows 10,000 and 1 MiB). */
export const HUNKS_REPLY_INSPECT = Object.freeze({ maxNodes: 9_000, maxBytes: 900 * 1024 });

/**
 * Why `hunks` offers only a whole-file decision. Closed: every reason `@axis/review`'s list (`changes.ts`) and its hunk
 * loading (`session.ts`, `hunks.ts`) produce, and `over_view_budget` for hunks that exist but would not fit this reply.
 * `too-large` (the change kind: over the preview size) and `too_large` (over `maxHunkFileBytes`) are different reasons, kept
 * as the core spells them. The host maps any other string to `unreadable`.
 */
export const REVIEW_HUNKS_FILE_LEVEL_REASONS = [
  "unsafe_path", "filtered_path", "attributes_untrusted", "added", "deleted", "type_change", "binary", "symlink", "submodule",
  "too-large", "no_content_change", "not_a_regular_file",
  "unreadable", "too_large", "diff_failed", "patch_too_large", "malformed", "too_many_hunks", "not_reproducible",
  "over_view_budget",
] as const;
export const reviewHunksFileLevelReasonSchema = z.enum(REVIEW_HUNKS_FILE_LEVEL_REASONS);
export type ReviewHunksFileLevelReason = z.infer<typeof reviewHunksFileLevelReasonSchema>;

/**
 * `details.reason` values of the two methods. A handler cannot raise `E_POLICY_DENIED` (the daemon reserves it), so every
 * refusal of these handlers is `E_CONFLICT`, `E_NOT_FOUND` or `E_INVALID_ARGUMENT` with one of these (the `diff` set plus
 * the new ones); `E_UNAVAILABLE`, `E_CANCELLED` and `E_INTERNAL` carry none.
 */
export const REVIEW_HUNKS_REASONS = [...REVIEW_DIFF_REASONS, "file_not_found"] as const;
export const REVIEW_BUILD_REASONS = [...REVIEW_DIFF_REASONS, "file_not_found", "head_moved", "selection_stale", "no_hunks", "detached_head"] as const;
export const reviewHunksReasonSchema = z.enum(REVIEW_HUNKS_REASONS);
export const reviewBuildReasonSchema = z.enum(REVIEW_BUILD_REASONS);

/** The exact version of a file the user saw (sha256 over both modes and object ids, the old path and the protected flag). */
export const versionIdSchema = contentIdSchema;
/** `@axis/review`'s `hunkId`: the hunk's index in the file and 16 hex of its digest. */
export const hunkIdSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,3}):[0-9a-f]{16}$/);
const hunkHeaderSchema = z.string().regex(/^@@ -[0-9]{1,10},[0-9]{1,10} \+[0-9]{1,10},[0-9]{1,10} @@$/);

/** One line as the view shows it: escaped, with no control or invisible character left and no combining mark in front. */
export const hunkLineSchema = z.strictObject({
  kind: z.enum([" ", "-", "+"]),
  text: z
    .string()
    .max(MAX_HUNK_LINE_CHARS)
    .refine((t) => !CONTENT_REFUSED.test(t), { message: "no control or invisible characters" })
    .refine((t) => !CONTENT_LEADING_REFUSED.test(t), { message: "no combining mark at the start" }),
  eol: z.enum(["lf", "crlf", "none"]),
  /** Part of the line is not in `text`; this flag is the only marker (REV-1). */
  truncated: z.boolean(),
});
export const hunkWireSchema = z
  .strictObject({
    id: hunkIdSchema,
    header: hunkHeaderSchema,
    lines: z.array(hunkLineSchema).min(1).max(MAX_HUNKS_REPLY_LINES),
    /** An added or removed line is cut: accepting this hunk needs its id in `acknowledgedHunkIds`. */
    truncated: z.boolean(),
  })
  .refine((h) => h.truncated === h.lines.some((l) => l.kind !== " " && l.truncated), "the hunk flag and its lines disagree");
export type HunkWire = z.infer<typeof hunkWireSchema>;

const unique = (ids: readonly string[]): boolean => new Set(ids).size === ids.length;
const lineCount = (hunks: readonly HunkWire[]): number => hunks.reduce((n, h) => n + h.lines.length, 0);
const charCount = (hunks: readonly HunkWire[]): number => hunks.reduce((n, h) => h.lines.reduce((m, l) => m + l.text.length, n), 0);

export const reviewHunksRequestSchema = guarded(z.strictObject({ workspaceId: workspaceIdSchema, fileId: fileIdSchema }));
export const reviewHunksResponseSchema = guarded(
  z
    .strictObject({
      /** HEAD of the round the hunks come from: what `build` must be asked against. */
      head: objectIdSchema,
      fileId: fileIdSchema,
      versionId: versionIdSchema,
      hunks: z.array(hunkWireSchema).min(1).max(MAX_HUNKS_REPLY_HUNKS).optional(),
      fileLevelReason: reviewHunksFileLevelReasonSchema.optional(),
    })
    .refine((r) => (r.hunks === undefined) !== (r.fileLevelReason === undefined), "exactly one of hunks and fileLevelReason")
    .refine((r) => r.hunks === undefined || unique(r.hunks.map((h) => h.id)), "duplicate hunk id")
    .refine((r) => r.hunks === undefined || lineCount(r.hunks) <= MAX_HUNKS_REPLY_LINES, "too many lines")
    .refine((r) => r.hunks === undefined || charCount(r.hunks) <= MAX_HUNKS_REPLY_CHARS, "too much text"),
);
export type ReviewHunksResponse = z.infer<typeof reviewHunksResponseSchema>;

/** Whether a candidate `hunks` reply fits with the host's headroom: the schema, then the message walk at the tighter bounds. */
export function hunksReplyFits(reply: unknown): boolean {
  return reviewHunksResponseSchema.safeParse(reply).success && inspectMessage(reply, HUNKS_REPLY_INSPECT).ok;
}

const idList = z.array(hunkIdSchema).max(MAX_HUNKS_REPLY_HUNKS).refine(unique, "duplicate hunk id");
export const selectionItemSchema = z.union([
  z.strictObject({ fileId: fileIdSchema, versionId: versionIdSchema, whole: z.literal(true), acknowledged: z.literal(true).optional() }),
  z
    .strictObject({ fileId: fileIdSchema, versionId: versionIdSchema, hunkIds: idList.min(1), acknowledgedHunkIds: idList.optional() })
    .refine((s) => (s.acknowledgedHunkIds ?? []).every((id) => s.hunkIds.includes(id)), "an acknowledged hunk is not selected"),
]);
export type SelectionItem = z.infer<typeof selectionItemSchema>;
const idsIn = (s: SelectionItem): number => ("hunkIds" in s ? s.hunkIds.length + (s.acknowledgedHunkIds?.length ?? 0) : 0);
const selectionSchema = z
  .array(selectionItemSchema)
  .min(1)
  .max(200)
  .refine((sel) => unique(sel.map((s) => s.fileId)), "duplicate file id")
  .refine((sel) => sel.reduce((n, s) => n + idsIn(s), 0) <= MAX_SELECTION_HUNK_IDS, "too many hunk ids");

export const reviewBuildRequestSchema = guarded(z.strictObject({ workspaceId: workspaceIdSchema, head: objectIdSchema, selection: selectionSchema }));
export const reviewBuildResponseSchema = guarded(
  z.strictObject({
    head: objectIdSchema,
    branch: axisBranchSchema,
    /** The reviewed tree: `reviewedTreeHash` of `axis.git/1.commit`, with `head` as `expectedParent`. */
    treeHash: objectIdSchema,
    /** What the tree holds, in request order; a file with every hunk selected comes back `whole: true`. */
    selection: selectionSchema,
  }),
);
export type ReviewBuildResponse = z.infer<typeof reviewBuildResponseSchema>;
