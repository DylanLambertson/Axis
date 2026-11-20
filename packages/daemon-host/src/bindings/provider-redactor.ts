// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { MAX_STRING_CHARS, isWellFormedString, placeholder, type Redactor } from "@axis/audit";
import type { Redactor as ProviderRedactor } from "@axis/providers";

/**
 * The host redactor as the providers' redaction hook, and the check for a registered secret in provider output. Kept
 * apart from `providers.ts` so the agent binding (the mock's guard) does not load the vault or the adapter (review c6 N6).
 */

/**
 * The host's audit redactor as the providers' redaction hook (PRV-2): anything it would change counts as a secret. The redactor
 * reads at most `MAX_STRING_CHARS` of a string and cuts the rest, so a longer string (a long file read or command output) is
 * judged window by window (`windowBounds`) instead of as "changed" by the cut, which failed every run with a long tool result.
 * A string that is not well-formed UTF-16 still counts, as the redactor's repair would change it.
 */
export function providerRedactor(r: Redactor): ProviderRedactor {
  return {
    redact: (t) => r.redactString(t),
    containsSecret: (t) => {
      if (t.length <= SCAN_CHARS) return r.redactString(t) !== t;
      if (!isWellFormedString(t)) return true;
      for (const w of windowsOf(t)) if (r.redactString(w) !== w) return true;
      return false;
    },
  };
}

/** The redactor reads at most this many characters of one string. */
const SCAN_CHARS = MAX_STRING_CHARS;
/**
 * The longest form of a registered key the redactor matches: a key is at most 4096 printable characters, and its
 * URL-encoded form (the longest of the raw, JSON-escaped, URL-encoded, base64 and hex forms) at most three times that.
 */
export const MAX_KEY_FORM_CHARS = 12_288;
/** Two less than the bare overlap: a window edge moved off a surrogate pair (one at each end) still leaves a whole key form. */
const STEP = SCAN_CHARS - MAX_KEY_FORM_CHARS - 2;
const MARK = placeholder("registered-secret");

const marks = (s: string): number => s.split(MARK).length - 1;

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/**
 * `text` in windows of at most `SCAN_CHARS` that overlap by at least `MAX_KEY_FORM_CHARS`: a registered key form, and every
 * pattern rule's anchor with its shortest match, lies wholly inside one window. A window never splits a surrogate pair (the
 * redactor would repair the half and report a change). The bounds `[start, end)` of each, exported for the tests.
 */
export function* windowBounds(text: string): Generator<readonly [number, number]> {
  for (let i = 0; ; i += STEP) {
    let start = i;
    let end = Math.min(i + SCAN_CHARS, text.length);
    if (start > 0 && isLow(text.charCodeAt(start)) && isHigh(text.charCodeAt(start - 1))) start += 1;
    if (end < text.length && isHigh(text.charCodeAt(end - 1)) && isLow(text.charCodeAt(end))) end -= 1;
    yield [start, end];
    if (i + SCAN_CHARS >= text.length) return;
  }
}

function* windowsOf(text: string): Generator<string> {
  for (const [start, end] of windowBounds(text)) yield text.slice(start, end);
}

/**
 * True when `text` holds a secret registered with the host redactor (a vault key once read), in any form the redactor
 * knows. Only registered secrets count: a pattern rule's match (an example key in an answer) does not. Long text is
 * scanned in overlapping windows, so a form up to `MAX_KEY_FORM_CHARS` long is never split between two of them.
 */
export function holdsRegisteredSecret(r: Redactor, text: string): boolean {
  for (const w of windowsOf(text)) if (marks(r.redactString(w)) > marks(w)) return true;
  return false;
}
