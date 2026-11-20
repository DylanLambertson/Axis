// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { CF_RANGES, INVISIBLE_RANGES, rangesToClass } from "./display.js";
import { objectIdSchema } from "./git.js";
import { countSchema, displayTextSchema, guarded } from "./guard.js";
import { contentIdSchema, fileIdSchema, MAX_REVIEW_PATH } from "./review-ids.js";
import { workspaceIdSchema } from "./worktrees.js";

/**
 * `axis.review/1.content` (ticket RV-CONTENT, docs/design/review-core.md section 6b): what a changed file WOULD commit, as a
 * closed, bounded and escaped view, so the user can see the content of a file the list alone does not show (uncut text,
 * binary, over the preview size) before acknowledging it. Read side only: nothing is accepted or recorded here.
 *
 * Every view comes from the snapshot tree's entry (mode and object id) the `diff` of the same moment builds its tree from,
 * read from the object store and never from the work tree, and carries the `contentId` of that entry, computed exactly as
 * `diff` computes it (`<newMode> <newOid>`, with ` protected` appended for a WT-3 protected file). An acknowledgement
 * `{ fileId, contentId }` taken from this reply therefore names the content that was shown: if the file changes, moves, or
 * stops (or starts) being protected, the id differs and the acknowledgement no longer applies.
 */

/** Files one request may name, and one reply may show. */
export const MAX_CONTENT_FILES = 8;
/** Longest shown line, in UTF-16 units of the escaped text; a longer line is cut at the end and counted in `cutLines`. */
export const MAX_CONTENT_LINE = 512;
/** Lines shown per file (`first` and `last` together). */
export const MAX_CONTENT_LINES = 256;
/** UTF-16 units of shown text per file (all lines and a link target). */
export const MAX_CONTENT_FILE_CHARS = 32_768;
/** UTF-16 units of shown text per reply. At most 3 UTF-8 bytes a unit, so a reply stays far inside the 1 MiB message bound. */
export const MAX_CONTENT_RESPONSE_CHARS = 131_072;
/** A text file above this many bytes is `too-large`: only a first and a last excerpt are shown. */
export const MAX_CONTENT_TEXT_BYTES = 1_048_576;
/** A NUL byte in this many leading bytes makes a file `binary` (git's own rule, decided from the bytes, not from attributes). */
export const CONTENT_BINARY_SNIFF_BYTES = 8000;

/**
 * What a shown line may not hold: C0 controls except TAB, DEL, C1, surrogates, the line and paragraph separators, every
 * format character (bidi, zero-width, joiners, tags) and the invisible fillers. The host writes each as `\u{hex}`, a byte
 * that is not valid UTF-8 as `\xhh`, and a backslash as `\\`, so an escape cannot be forged and no terminal sequence
 * (ANSI CSI, OSC) reaches the client as anything but text.
 */
export const CONTENT_REFUSED = new RegExp(
  `[${rangesToClass([[0x0, 0x8], [0xa, 0x1f], [0x7f, 0x9f], [0xd800, 0xdfff], 0x2028, 0x2029, ...CF_RANGES, ...INVISIBLE_RANGES])}]`,
  "u",
);
/** A combining mark may not start a line: it would draw over whatever the client puts before the line (a gutter, a marker). */
export const CONTENT_LEADING_REFUSED = /^\p{M}/u;
export const contentLineSchema = z
  .string()
  .max(MAX_CONTENT_LINE)
  .refine((t) => !CONTENT_REFUSED.test(t), { message: "no control or invisible characters" })
  .refine((t) => !CONTENT_LEADING_REFUSED.test(t), { message: "no combining mark at the start" });

/** The first 12 hex digits of the object id (`git hash-object <file>` starts with them): an identity, never bytes. */
export const objectPrefixSchema = z.string().regex(/^[0-9a-f]{12}$/);
const lines = z.array(contentLineSchema).max(MAX_CONTENT_LINES);

export const CONTENT_UNAVAILABLE_REASONS = ["unsafe_path", "filtered"] as const;

/** Text up to `MAX_CONTENT_TEXT_BYTES`: every line in `first` when it fits, else the first and last lines with a gap. */
const textView = z.strictObject({
  kind: z.literal("text"),
  size: countSchema.max(MAX_CONTENT_TEXT_BYTES),
  /** Lines in the file (a final line without a newline counts). */
  lines: countSchema,
  first: lines,
  last: lines,
  /** Lines between `first` and `last` that are not shown. */
  omittedLines: countSchema,
  /** Shown lines cut at `MAX_CONTENT_LINE`. The view is the whole file only when this and `omittedLines` are 0. */
  cutLines: countSchema,
  finalNewline: z.boolean(),
});
/** Text over `MAX_CONTENT_TEXT_BYTES`: a first and a last excerpt. `last` is empty when the host could not read to the end. */
const tooLargeView = z.strictObject({
  kind: z.literal("too-large"),
  size: countSchema.min(MAX_CONTENT_TEXT_BYTES + 1),
  objectPrefix: objectPrefixSchema,
  first: lines,
  last: lines,
  readComplete: z.boolean(),
  cutLines: countSchema,
});
/** A NUL in the leading bytes: no byte of the file is sent. */
const binaryView = z.strictObject({ kind: z.literal("binary"), size: countSchema, objectPrefix: objectPrefixSchema });
/** The link target as text (never followed). `escapesWorktree`: it is absolute or climbs above the repository root. */
const symlinkView = z.strictObject({ kind: z.literal("symlink"), target: contentLineSchema, targetCut: z.boolean(), escapesWorktree: z.boolean() });
/** A gitlink: the commit it records (never entered). */
const submoduleView = z.strictObject({ kind: z.literal("submodule"), commit: objectIdSchema });
/** The change deletes the file: nothing would be committed at the path. */
const deletedView = z.strictObject({ kind: z.literal("deleted") });
/** Not shown, and not acknowledgeable: the path is unusable, or a content filter means the bytes are not what git stores. */
const unavailableView = z.strictObject({ kind: z.literal("unavailable"), reason: z.enum(CONTENT_UNAVAILABLE_REASONS) });

export const contentViewSchema = z.discriminatedUnion("kind", [textView, tooLargeView, binaryView, symlinkView, submoduleView, deletedView, unavailableView]);
export type ContentView = z.infer<typeof contentViewSchema>;

/** UTF-16 units of text a view shows. */
export function viewChars(v: ContentView): number {
  if (v.kind === "symlink") return v.target.length;
  if (v.kind !== "text" && v.kind !== "too-large") return 0;
  let n = 0;
  for (const l of v.first) n += l.length;
  for (const l of v.last) n += l.length;
  return n;
}

function viewConsistent(v: ContentView): boolean {
  if (v.kind === "text") {
    return v.first.length + v.last.length + v.omittedLines === v.lines && (v.last.length === 0 || v.omittedLines > 0) && v.cutLines <= v.first.length + v.last.length;
  }
  if (v.kind === "too-large") return (v.readComplete || v.last.length === 0) && v.cutLines <= v.first.length + v.last.length;
  return true;
}

export const reviewContentFileSchema = z
  .strictObject({
    fileId: fileIdSchema,
    displayPath: displayTextSchema(MAX_REVIEW_PATH),
    displayOldPath: displayTextSchema(MAX_REVIEW_PATH).optional(),
    /** WT-3, as in `diff`: true exactly when `protectedRules` is not empty; protected files come first. */
    protectedPath: z.boolean(),
    protectedRules: z.array(displayTextSchema(64)).max(4),
    /** The acknowledgement id of exactly this content (see the header); null only for an `unavailable` view. */
    contentId: contentIdSchema.nullable(),
    view: contentViewSchema,
  })
  .refine((f) => f.protectedPath === f.protectedRules.length > 0, "the protected flag and the rule names disagree")
  .refine((f) => (f.contentId === null) === (f.view.kind === "unavailable"), "a shown file, and only a shown file, has a content id")
  .refine((f) => viewConsistent(f.view), "the view's counts disagree")
  .refine((f) => (f.view.kind === "text" || f.view.kind === "too-large" ? f.view.first.length + f.view.last.length : 0) <= MAX_CONTENT_LINES, "too many lines")
  .refine((f) => viewChars(f.view) <= MAX_CONTENT_FILE_CHARS, "too much text for one file");
export type ReviewContentFile = z.infer<typeof reviewContentFileSchema>;

const uniqueIds = (ids: readonly string[]): boolean => new Set(ids).size === ids.length;

export const reviewContentRequestSchema = guarded(
  z.strictObject({
    workspaceId: workspaceIdSchema,
    /** `fileId`s from a `diff` reply. Unique, 1 to `MAX_CONTENT_FILES`. */
    fileIds: z.array(fileIdSchema).min(1).max(MAX_CONTENT_FILES).refine(uniqueIds, "duplicate file id"),
  }),
);
export const reviewContentResponseSchema = guarded(
  z
    .strictObject({
      /** HEAD when the worktree was read: the same `head` a `diff` of the same state reports. */
      head: objectIdSchema,
      files: z.array(reviewContentFileSchema).max(MAX_CONTENT_FILES),
      /** Requested ids that name no changed file of this review (it changed since the `diff`, or was never listed). */
      notFound: z.array(fileIdSchema).max(MAX_CONTENT_FILES),
    })
    .refine((r) => uniqueIds([...r.files.map((f) => f.fileId), ...r.notFound]), "duplicate file id")
    .refine((r) => r.files.length + r.notFound.length <= MAX_CONTENT_FILES, "more files than were asked for")
    .refine((r) => !r.files.some((f, i) => f.protectedPath && r.files.slice(0, i).some((g) => !g.protectedPath)), "protected files come first")
    .refine((r) => r.files.reduce((n, f) => n + viewChars(f.view), 0) <= MAX_CONTENT_RESPONSE_CHARS, "too much text for one reply"),
);
