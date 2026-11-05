// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

type Range = number | readonly [number, number];

/*
 * Explicit code point data, not `\p{..}` property classes: a property class follows the Unicode version of the engine that
 * runs it, so a daemon on one Node and a client on another Electron could disagree about a new code point, and a reply the
 * host escaped would be refused by the client. These tables are pinned (generated from Unicode 17.0, Node 24.22.1) and
 * are the definition: `displayTextSchema`, `safeTextSchema` and `toDisplayPath` all use them. A code point added to Unicode
 * later is NOT escaped or refused until the tables are extended, by every side at once.
 */
/** General category Cc (controls), Cs (surrogates), and the line and paragraph separators. */
export const CC_CS_LS_RANGES: readonly Range[] = [[0x0, 0x1f], [0x7f, 0x9f], [0xd800, 0xdfff], 0x2028, 0x2029];
/** General category Cf (format: soft hyphen, bidi, zero-width, joiners, number signs, tag characters) at Unicode 17.0. */
export const CF_RANGES: readonly Range[] = [
  0xad, [0x600, 0x605], 0x61c, 0x6dd, 0x70f, [0x890, 0x891], 0x8e2, 0x180e, [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x2064], [0x2066, 0x206f], 0xfeff, [0xfff9, 0xfffb], 0x110bd, 0x110cd, [0x13430, 0x1343f], [0x1bca0, 0x1bca3],
  [0x1d173, 0x1d17a], 0xe0001, [0xe0020, 0xe007f],
];
/** Invisible or smuggling characters that are not Cf: combining grapheme joiner, variation selectors, Hangul fillers, blank braille. */
export const INVISIBLE_RANGES: readonly Range[] = [0x34f, 0x115f, 0x1160, 0x2800, 0x3164, [0xfe00, 0xfe0f], 0xffa0, [0xe0100, 0xe01ef]];

const hex = (n: number): string => `\\u{${n.toString(16)}}`;
/** The body of a character class (`[...]`, `u` flag) for explicit ranges. */
export function rangesToClass(ranges: readonly Range[]): string {
  return ranges.map((r) => (typeof r === "number" ? hex(r) : `${hex(r[0])}-${hex(r[1])}`)).join("");
}

/** What `displayTextSchema` refuses: Cc, Cf, Cs, and the line and paragraph separators (explicit ranges, see above). */
export const REFUSED_DISPLAY = new RegExp(`[${rangesToClass([...CC_CS_LS_RANGES, ...CF_RANGES])}]`, "u");
const REFUSED = REFUSED_DISPLAY;

/** Shortest limit `toDisplayPath` takes: room for one escape (`\u{10ffff}` is 10 units), an ellipsis and a tail. */
export const MIN_DISPLAY_LIMIT = 24;

const ELLIPSIS = "\u2026";

function token(ch: string): string {
  if (ch === "\\") return "\\\\";
  // A literal ellipsis would mimic the mark of a cut, so it is escaped too: an ellipsis in the output always means a cut.
  if (ch === ELLIPSIS) return "\\u{2026}";
  if (!REFUSED.test(ch)) return ch;
  return `\\u{${(ch.codePointAt(0) as number).toString(16)}}`;
}

/**
 * Text that is safe to show and always passes `displayTextSchema(maxChars)`: every code point the schema refuses (and the
 * backslash and the ellipsis, so an escape cannot be forged and a cut cannot be mimicked) is written as `\u{hex}`, and a result longer than `maxChars` UTF-16 units is cut
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
