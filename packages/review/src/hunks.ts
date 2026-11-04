// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Per-hunk parsing and application (design §4). The parser trusts nothing in a header: a body is read by the counts the
// header states and must match them exactly, and the apply step proves every hunk against the old text. The text is
// split on "\n" only, so a CR stays part of its line (CRLF files) and U+2028, U+2029 and U+0085 are not line breaks.
import { createHash } from "node:crypto";

export interface HunkLine {
  readonly kind: " " | "-" | "+";
  /** Without the terminating "\n". A CR, if any, is still here. */
  readonly text: string;
  /** "\ No newline at end of file" followed this line (the old side for "-", the new side for "+", both for " "). */
  readonly noEol: boolean;
}

export interface Hunk {
  readonly index: number;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly HunkLine[];
  /** SHA-256 of the hunk text: a decision names a hunk by index and this digest, so a changed hunk is never matched. */
  readonly digest: string;
}

export type ParsedPatch =
  | { readonly ok: true; readonly hunks: readonly Hunk[] }
  | { readonly ok: false; readonly reason: "malformed" | "binary" | "too_many_hunks" };

const HEADER = /^@@ -(\d{1,9})(?:,(\d{1,9}))? \+(\d{1,9})(?:,(\d{1,9}))? @@(?: .*)?$/;

function digestOf(header: string, lines: readonly HunkLine[]): string {
  const h = createHash("sha256").update(header).update("\n");
  for (const l of lines) h.update(l.kind).update(l.text).update(l.noEol ? "\\\n" : "\n");
  return h.digest("hex");
}

/** The hunks of a single-file unified diff, as git writes it. */
export function parseUnifiedHunks(patch: string, maxHunks: number): ParsedPatch {
  const lines = patch.split("\n");
  // A diff always ends with a newline; a last line without one is a cut-off.
  if (lines.pop() !== "") return { ok: false, reason: "malformed" };
  let i = 0;
  while (i < lines.length && !(lines[i] as string).startsWith("@@")) {
    const l = lines[i] as string;
    if (l.startsWith("Binary files ") || l.startsWith("GIT binary patch")) return { ok: false, reason: "binary" };
    i++;
  }
  const hunks: Hunk[] = [];
  while (i < lines.length) {
    const header = lines[i] as string;
    const m = HEADER.exec(header);
    if (!m) return { ok: false, reason: "malformed" };
    if (hunks.length >= maxHunks) return { ok: false, reason: "too_many_hunks" };
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    if (oldCount === 0 && newCount === 0) return { ok: false, reason: "malformed" };
    i++;
    const body: { kind: " " | "-" | "+"; text: string; noEol: boolean }[] = [];
    let o = 0;
    let n = 0;
    while (o < oldCount || n < newCount) {
      const line = lines[i];
      if (line === undefined) return { ok: false, reason: "malformed" };
      const c = line[0];
      if (c === " " && o < oldCount && n < newCount) {
        o++;
        n++;
      } else if (c === "-" && o < oldCount) o++;
      else if (c === "+" && n < newCount) n++;
      else return { ok: false, reason: "malformed" };
      body.push({ kind: c, text: line.slice(1), noEol: false });
      i++;
      const next = lines[i];
      if (next !== undefined && next.startsWith("\\ ")) {
        (body[body.length - 1] as { noEol: boolean }).noEol = true;
        i++;
      }
    }
    const next = lines[i];
    // Whatever follows a complete hunk must be the next header (or the end): extra lines mean the header lied. Defence in
    // depth, with no test of its own: the HEADER match on the next loop turn refuses the same input, and so does the self-check.
    if (next !== undefined && !next.startsWith("@@")) return { ok: false, reason: "malformed" };
    hunks.push({
      index: hunks.length,
      oldStart: Number(m[1]),
      oldCount,
      newStart: Number(m[3]),
      newCount,
      lines: body,
      digest: digestOf(header, body),
    });
  }
  return { ok: true, hunks };
}

/** Lines with their terminators; the last one has none when the text does not end with "\n". */
export function splitKeepingEol(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (let nl = text.indexOf("\n"); nl !== -1; nl = text.indexOf("\n", from)) {
    out.push(text.slice(from, nl + 1));
    from = nl + 1;
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

/**
 * Applies the hunks whose index is in `accepted` to `oldText`. Each accepted hunk's old side must equal the old text at
 * its position exactly, terminators included; hunks must be in order and must not overlap. Returns null when anything
 * does not hold, and the caller then offers only a whole-file decision for that file.
 */
export function applyHunks(oldText: string, hunks: readonly Hunk[], accepted: ReadonlySet<number>): string | null {
  const old = splitKeepingEol(oldText);
  const out: string[] = [];
  let cursor = 0;
  let previousEnd = 0;
  for (const h of hunks) {
    // Position and order are judged for every hunk, accepted or not, so a hunk that lies voids the whole file.
    const at = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
    if (at < previousEnd || at + h.oldCount > old.length) return null;
    previousEnd = at + h.oldCount;
    if (!accepted.has(h.index)) continue;
    for (; cursor < at; cursor++) out.push(old[cursor] as string);
    for (const l of h.lines) {
      if (l.kind !== "+") {
        if (old[cursor] !== l.text + (l.noEol ? "" : "\n")) return null;
        cursor++;
      }
      if (l.kind !== "-") out.push(l.text + (l.noEol ? "" : "\n"));
    }
  }
  for (; cursor < old.length; cursor++) out.push(old[cursor] as string);
  return out.join("");
}

/** The id git gives a blob with this content: SHA-1 for a 40-digit id, SHA-256 for a 64-digit one. */
export function blobOid(text: string, idLength: number): string {
  const body = Buffer.from(text, "utf8");
  return createHash(idLength === 64 ? "sha256" : "sha1")
    .update(`blob ${body.length}\0`)
    .update(body)
    .digest("hex");
}

/** The names of hunk `index`: stable for the content of the hunk, never reusable for a different one. */
export function hunkId(h: Pick<Hunk, "index" | "digest">): string {
  return `${h.index}:${h.digest.slice(0, 16)}`;
}
