// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// What the UI is shown (FT-1, DASH-1): text from objects only, escaped, size-capped; placeholders for binary content;
// a link as its target text and never as what it points at.
import { escapeWithInfo } from "./display.js";
import { unavailable } from "./errors.js";
import type { Hunk } from "./hunks.js";
import { hunkId } from "./hunks.js";
import { expectComplete, objectSize, type ReviewGit } from "./gitcall.js";
import type { ReviewFile, ReviewLimits } from "./types.js";

export interface HunkViewLine {
  readonly kind: " " | "-" | "+";
  /** Escaped. A trailing CR is not text: it is `eol: "crlf"`. */
  readonly text: string;
  readonly eol: "lf" | "crlf" | "none";
  /** Part of the line is not in `text`. Nothing marks the cut inside the text; this flag is the only marker. */
  readonly truncated: boolean;
}

export interface HunkView {
  /** Name a decision by this. It changes if the hunk's content changes. */
  readonly id: string;
  readonly header: string;
  readonly lines: readonly HunkViewLine[];
  /** At least one line is cut. Accepting this hunk accepts text the reviewer was not shown (see `acceptHunk`). */
  readonly truncated: boolean;
}

/** Whether a hunk has a line the view cannot show whole. */
export function hunkTruncated(h: Hunk, limits: ReviewLimits): boolean {
  const max = limits.maxDisplay * 4;
  return h.lines.some((l) => l.text.length > max && Array.from(l.text).length > max);
}

export function hunkView(h: Hunk, limits: ReviewLimits): HunkView {
  return {
    id: hunkId(h),
    header: `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`,
    lines: h.lines.map((l) => {
      const crlf = !l.noEol && l.text.endsWith("\r");
      const e = escapeWithInfo(crlf ? l.text.slice(0, -1) : l.text, { maxLength: limits.maxDisplay * 4, keepTab: true, ellipsis: false });
      return { kind: l.kind, text: e.text, eol: l.noEol ? "none" : crlf ? "crlf" : "lf", truncated: e.truncated };
    }),
    truncated: hunkTruncated(h, limits),
  };
}

export type Preview =
  | { readonly kind: "text"; readonly text: string; readonly lines: number; readonly truncatedLines: number }
  | { readonly kind: "binary"; readonly size: number }
  | { readonly kind: "too-large"; readonly size: number }
  | { readonly kind: "symlink"; readonly target: string | undefined; readonly escapesWorktree: boolean }
  | { readonly kind: "submodule"; readonly commit: string }
  | { readonly kind: "absent" };

/** One side of a file, from the object store. Nothing is read from the file system, so nothing can be followed. */
export async function previewSide(git: ReviewGit, f: ReviewFile, side: "old" | "new", limits: ReviewLimits): Promise<Preview> {
  const mode = side === "old" ? f.oldMode : f.newMode;
  const oid = side === "old" ? f.oldOid : f.newOid;
  if (mode === "000000") return { kind: "absent" };
  if (mode === "160000") return { kind: "submodule", commit: oid };
  if (mode === "120000") return { kind: "symlink", target: f.link?.target, escapesWorktree: f.link?.escapesWorktree ?? true };
  if (f.kind === "binary") return { kind: "binary", size: 0 };
  const size = await objectSize(git, oid);
  if (size === undefined) throw unavailable("could not read the size of a file version");
  if (size > limits.maxPreviewBytes) return { kind: "too-large", size };
  const body = expectComplete(await git(["cat-file", "blob", oid]), "read a file version");
  if (body.includes("\0")) return { kind: "binary", size };
  const lines = body.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let truncatedLines = 0;
  const text = lines
    .map((l) => {
      const e = escapeWithInfo(l.endsWith("\r") ? l.slice(0, -1) : l, { maxLength: limits.maxDisplay * 4, keepTab: true, ellipsis: false });
      if (e.truncated) truncatedLines++;
      return e.text;
    })
    .join("\n");
  return { kind: "text", text, lines: lines.length, truncatedLines };
}
