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
  /** Escaped. A CR is the line end only when an LF follows it (`eol: "crlf"`); a bare CR at the end of a file is text. */
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
  /** At least one added or removed line is cut. Accepting this hunk accepts text the reviewer was not shown (see `acceptHunk`). */
  readonly truncated: boolean;
}

/**
 * What the view shows of one line, and whether it cut it (REV-1). `text` is the line without its LF; `terminated` says an
 * LF followed it. Only then is a trailing CR the CRLF line end; a bare CR at the end of a file is content, so it is shown
 * (escaped) or it is what is cut. Every view and every cut-line gate (a hunk accept, a whole-file accept, the recheck in
 * `build`) calls this one function, so a byte the view did not show is always a cut line.
 */
export function viewLine(text: string, terminated: boolean, limits: ReviewLimits): { text: string; eol: HunkViewLine["eol"]; truncated: boolean } {
  const crlf = terminated && text.endsWith("\r");
  const e = escapeWithInfo(crlf ? text.slice(0, -1) : text, { maxLength: limits.maxDisplay * 4, keepTab: true, ellipsis: false });
  return { text: e.text, eol: terminated ? (crlf ? "crlf" : "lf") : "none", truncated: e.truncated };
}

/** Whether an added or removed line of the hunk is cut. Context lines are not accepted content, so they do not count. */
export function hunkTruncated(h: Hunk, limits: ReviewLimits): boolean {
  return h.lines.some((l) => l.kind !== " " && viewLine(l.text, !l.noEol, limits).truncated);
}

export function hunkView(h: Hunk, limits: ReviewLimits): HunkView {
  const lines = h.lines.map((l) => ({ kind: l.kind, ...viewLine(l.text, !l.noEol, limits) }));
  return {
    id: hunkId(h),
    header: `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`,
    lines,
    truncated: lines.some((l) => l.kind !== " " && l.truncated),
  };
}

/** A text blob as lines for the view: each with whether an LF ended it (the last one may not have). */
function blobLines(body: string): { text: string; terminated: boolean }[] {
  const parts = body.split("\n");
  const last = parts.pop() as string;
  const lines = parts.map((text) => ({ text, terminated: true }));
  if (last !== "") lines.push({ text: last, terminated: false });
  return lines;
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
  const lines = blobLines(body);
  let truncatedLines = 0;
  const text = lines
    .map((l) => {
      const v = viewLine(l.text, l.terminated, limits);
      if (v.truncated) truncatedLines++;
      return v.text;
    })
    .join("\n");
  return { kind: "text", text, lines: lines.length, truncatedLines };
}

/** Whether any line of a text blob is cut by the view. */
export function textCut(body: string, limits: ReviewLimits): boolean {
  return blobLines(body).some((l) => viewLine(l.text, l.terminated, limits).truncated);
}
