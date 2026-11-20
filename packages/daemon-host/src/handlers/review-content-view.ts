// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { CONTENT_BINARY_SNIFF_BYTES, CONTENT_LEADING_REFUSED, CONTENT_REFUSED, MAX_CONTENT_LINE, MAX_CONTENT_LINES, MAX_CONTENT_TEXT_BYTES, type ContentView } from "@axis/protocol";

/**
 * The views of `axis.review/1.content` (docs/design/review-core.md section 6b), built from bytes. Pure and total: any bytes
 * in, a view that passes `contentViewSchema` out. Work is bounded by what is shown, not by the file: a line is decoded
 * only up to `MAX_CONTENT_LINE` units, and only the lines that are shown are decoded at all.
 */

/**
 * How much of an object is read, decided from its size before any byte is held (`readNewBlob`). Up to 4 MiB: the whole
 * object, so a text file over `MAX_CONTENT_TEXT_BYTES` still shows its last lines. Above: the first 256 KiB only (more than
 * the first half of a view can show unless its lines are very long), so a reply holds at most one 4 MiB object at a time,
 * however large the files are. A link target: 4 KiB, enough for the longest shown target (512 units, at most 4 bytes each).
 */
export const TEXT_READ = { wholeUpTo: 4 * 1_048_576, prefix: 256 * 1024 } as const;
export const LINK_READ = { wholeUpTo: 4096, prefix: 4096 } as const;

/** The length in bytes of a valid UTF-8 sequence at `i`, or 0 when the byte there does not start one (strict, RFC 3629). */
function sequenceLength(b: Uint8Array, i: number, end: number): number {
  const c = b[i] as number;
  if (c < 0x80) return 1;
  const cont = (k: number, lo = 0x80, hi = 0xbf): boolean => i + k < end && (b[i + k] as number) >= lo && (b[i + k] as number) <= hi;
  if (c >= 0xc2 && c <= 0xdf) return cont(1) ? 2 : 0;
  if (c === 0xe0) return cont(1, 0xa0) && cont(2) ? 3 : 0;
  // 0xED with 0xA0..0xBF would be a surrogate: not valid UTF-8.
  if (c === 0xed) return cont(1, 0x80, 0x9f) && cont(2) ? 3 : 0;
  if (c >= 0xe1 && c <= 0xef) return cont(1) && cont(2) ? 3 : 0;
  if (c === 0xf0) return cont(1, 0x90) && cont(2) && cont(3) ? 4 : 0;
  if (c >= 0xf1 && c <= 0xf3) return cont(1) && cont(2) && cont(3) ? 4 : 0;
  if (c === 0xf4) return cont(1, 0x80, 0x8f) && cont(2) && cont(3) ? 4 : 0;
  return 0;
}

function codePoint(b: Uint8Array, i: number, n: number): number {
  const c = b[i] as number;
  if (n === 1) return c;
  const t = (k: number): number => (b[i + k] as number) & 0x3f;
  if (n === 2) return ((c & 0x1f) << 6) | t(1);
  if (n === 3) return ((c & 0x0f) << 12) | (t(1) << 6) | t(2);
  return ((c & 0x07) << 18) | (t(1) << 12) | (t(2) << 6) | t(3);
}

/** One code point as shown text: a backslash doubled, a refused code point (or a combining mark that would lead) as `\u{hex}`, TAB kept. */
function token(cp: number, leading: boolean): string {
  if (cp === 0x5c) return "\\\\";
  const ch = String.fromCodePoint(cp);
  return CONTENT_REFUSED.test(ch) || (leading && CONTENT_LEADING_REFUSED.test(ch)) ? `\\u{${cp.toString(16)}}` : ch;
}

/**
 * Bytes `[start, end)` as one escaped line of at most `max` UTF-16 units. A byte that does not start valid UTF-8 is `\xhh`.
 * `cut` is true when part of the line is not in `text` (no marker is added inside the text).
 */
export function escapeBytes(b: Uint8Array, start: number, end: number, max: number): { readonly text: string; readonly cut: boolean } {
  let text = "";
  for (let i = start; i < end; ) {
    const n = sequenceLength(b, i, end);
    const t = n === 0 ? `\\x${(b[i] as number).toString(16).padStart(2, "0")}` : token(codePoint(b, i, n), text === "");
    if (text.length + t.length > max) return { text, cut: true };
    text += t;
    i += n === 0 ? 1 : n;
  }
  return { text, cut: false };
}

interface Excerpt {
  readonly first: string[];
  readonly last: string[];
  readonly lines: number;
  readonly cutLines: number;
  readonly finalNewline: boolean;
}

/**
 * Lines of `b` (split on LF only; a CR stays in the line and is shown as `\u{d}`). All of them when they fit in `maxLines`
 * and `budget` units, else the first and the last lines, each side up to half of both bounds. With `complete` false the
 * bytes are a prefix: its unfinished last line is not shown and nothing is taken from the end.
 */
function excerpt(b: Uint8Array, complete: boolean, budget: number): Excerpt {
  const end = b.length;
  const finalNewline = end > 0 && b[end - 1] === 0x0a;
  let newlines = 0;
  for (let i = b.indexOf(0x0a); i !== -1; i = b.indexOf(0x0a, i + 1)) newlines++;
  const lines = newlines + (end > 0 && !finalNewline ? 1 : 0);
  // Usable lines: in a prefix, only those that end with LF.
  const usable = complete ? lines : newlines;
  let cutLines = 0;
  const render = (s: number, e: number): string => {
    const r = escapeBytes(b, s, e, MAX_CONTENT_LINE);
    if (r.cut) cutLines++;
    return r.text;
  };
  const forward = (maxLines: number, maxChars: number): { out: string[]; chars: number } => {
    const out: string[] = [];
    let chars = 0;
    let s = 0;
    while (out.length < Math.min(maxLines, usable)) {
      const nl = b.indexOf(0x0a, s);
      const e = nl === -1 ? end : nl;
      const before = cutLines;
      const text = render(s, e);
      if (chars + text.length > maxChars) {
        cutLines = before;
        break;
      }
      out.push(text);
      chars += text.length;
      s = e + 1;
    }
    return { out, chars };
  };
  if (usable <= MAX_CONTENT_LINES && complete) {
    const all = forward(MAX_CONTENT_LINES, budget);
    if (all.out.length === lines) return { first: all.out, last: [], lines, cutLines, finalNewline };
    cutLines = 0;
  }
  const half = Math.floor(MAX_CONTENT_LINES / 2);
  const halfBudget = Math.floor(budget / 2);
  const head = forward(half, halfBudget);
  // A prefix whose LF-terminated lines all fit: its unfinished last line is shown too, cut (one long line of minified code
  // or JSON would otherwise show nothing).
  const tail = b.lastIndexOf(0x0a) + 1;
  if (!complete && head.out.length === usable && head.out.length < half && tail < end) {
    const text = escapeBytes(b, tail, end, MAX_CONTENT_LINE).text;
    if (head.chars + text.length <= halfBudget) {
      head.out.push(text);
      cutLines++;
    }
  }
  const last: string[] = [];
  if (complete) {
    let chars = 0;
    // `e` is the end of the line being taken; walk back from the last line, never into the lines already shown.
    let e = finalNewline ? end - 1 : end;
    while (last.length < half && lines - last.length > head.out.length) {
      const s = e === 0 ? 0 : b.lastIndexOf(0x0a, e - 1) + 1;
      const before = cutLines;
      const text = render(s, e);
      if (chars + text.length > halfBudget) {
        cutLines = before;
        break;
      }
      last.unshift(text);
      chars += text.length;
      e = s - 1;
    }
  }
  return { first: head.out, last, lines, cutLines, finalNewline };
}

/** Whether git would call these bytes binary: a NUL in the leading bytes. */
export const looksBinary = (b: Uint8Array): boolean => b.subarray(0, CONTENT_BINARY_SNIFF_BYTES).includes(0);

/** The view of a regular file's bytes (`complete` false: a prefix of `size` bytes). `budget`: UTF-16 units it may show. */
export function fileView(blob: { readonly size: number; readonly bytes: Uint8Array; readonly complete: boolean }, oid: string, budget: number): ContentView {
  const objectPrefix = oid.slice(0, 12);
  if (looksBinary(blob.bytes)) return { kind: "binary", size: blob.size, objectPrefix };
  if (blob.size > MAX_CONTENT_TEXT_BYTES) {
    const x = excerpt(blob.bytes, blob.complete, budget);
    return { kind: "too-large", size: blob.size, objectPrefix, first: x.first, last: x.last, readComplete: blob.complete, cutLines: x.cutLines };
  }
  // At most `MAX_CONTENT_TEXT_BYTES`, far below any runner limit: a cut read here is a fault, never shown as the whole file.
  if (!blob.complete) throw new RangeError("a small file did not read whole");
  const x = excerpt(blob.bytes, true, budget);
  return {
    kind: "text",
    size: blob.size,
    lines: x.lines,
    first: x.first,
    last: x.last,
    omittedLines: x.lines - x.first.length - x.last.length,
    cutLines: x.cutLines,
    finalNewline: x.finalNewline,
  };
}

/** The view of a link: its target as text (bounded by the line limit and `budget`), never followed. A prefix is cut. */
export function linkView(target: { readonly bytes: Uint8Array; readonly complete: boolean }, escapesWorktree: boolean, budget: number): ContentView {
  const r = escapeBytes(target.bytes, 0, target.bytes.length, Math.min(MAX_CONTENT_LINE, budget));
  return { kind: "symlink", target: r.text, targetCut: r.cut || !target.complete, escapesWorktree };
}
