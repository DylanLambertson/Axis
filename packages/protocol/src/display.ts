// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * The code points `displayTextSchema` refuses: control (Cc), format (Cf: bidi, zero-width, tag characters, the Arabic
 * number signs), surrogate (Cs, a lone one in a JS string) and the line and paragraph separators.
 */
const REFUSED = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;

/** Shortest limit `toDisplayPath` takes: room for one escape (`\u{10ffff}` is 10 units), an ellipsis and a tail. */
export const MIN_DISPLAY_LIMIT = 24;

const ELLIPSIS = "\u2026";

function token(ch: string): string {
  if (ch === "\\") return "\\\\";
  if (!REFUSED.test(ch)) return ch;
  return `\\u{${(ch.codePointAt(0) as number).toString(16)}}`;
}

/**
 * Text that is safe to show and always passes `displayTextSchema(maxChars)`: every code point the schema refuses (and the
 * backslash, so an escape cannot be forged) is written as `\u{hex}`, and a result longer than `maxChars` UTF-16 units is cut
 * in the middle, on a code point or escape boundary, with an ellipsis. It is pure and total: any string in, a string of at most
 * `maxChars` units out, and the same input always gives the same output.
 *
 * The cut can make two different paths show the same text (they differ only in the part cut out). A display string is
 * therefore never an identity: files are named by `fileId` (see `review.ts`).
 *
 * The bound is on the ESCAPED text: a code point that needs `\u{e0001}` takes 9 units, so a short name can still be cut.
 * Use it for every path and every line of text a handler puts into a `displayTextSchema` field of a response.
 */
export function toDisplayPath(raw: string, maxChars: number): string {
  if (typeof raw !== "string") throw new TypeError("toDisplayPath takes a string");
  if (!Number.isInteger(maxChars) || maxChars < MIN_DISPLAY_LIMIT) throw new RangeError(`the limit must be an integer of at least ${MIN_DISPLAY_LIMIT}`);
  const tokens = Array.from(raw, token);
  const total = tokens.reduce((n, t) => n + t.length, 0);
  if (total <= maxChars) return tokens.join("");
  const headBudget = Math.ceil((maxChars - 1) / 2);
  const tailBudget = maxChars - 1 - headBudget;
  let head = "";
  let i = 0;
  while (i < tokens.length && head.length + (tokens[i] as string).length <= headBudget) head += tokens[i++];
  let tail = "";
  for (let j = tokens.length - 1; j >= i; j--) {
    const t = tokens[j] as string;
    if (tail.length + t.length > tailBudget) break;
    tail = t + tail;
  }
  return `${head}${ELLIPSIS}${tail}`;
}
