// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash } from "node:crypto";
import { MAX_STRING_CHARS, isWellFormedString, placeholder, type Redactor } from "@axis/audit";
import type { Redactor as ProviderRedactor } from "@axis/providers";

/**
 * The host redactor as the providers' redaction hook, and the check for a registered secret in provider output. Kept
 * apart from `providers.ts` so the agent binding (the mock's guard) does not load the vault or the adapter (review c6 N6).
 */

/**
 * Most "no secret" verdicts on long strings one hook keeps, least recently used dropped first (review secret-scan-windows r1
 * SF-2). One hook serves every run on its provider, and each request walks its run's whole history, so the bound must hold
 * every live run's long strings at once, or the walk evicts its own verdicts and every request scans the whole history again.
 * A run's caps bound its long strings (over 16,384 characters): tool inputs 8 MiB / 16,385 = 511, results 4 MiB / 16,385 =
 * 255, at most one model text per turn (24) and the prompt: 791, rounded up to 1,024, times 8 live runs (the service's
 * default `maxActive`). The least recently used entries go first: those of runs that ended, but also those of a live run that
 * has sent nothing for a while (parked on an approval) when other runs fill the bound; such a run's next request scans its
 * history once more, which costs time and never a verdict.
 * About 2 MB of keys. Pinned by a test against the real caps.
 */
export const MAX_CLEAN_VERDICTS = 8 * 1024;

/**
 * The host's audit redactor as the providers' redaction hook (PRV-2): anything it would change counts as a secret. The redactor
 * reads at most `MAX_STRING_CHARS` of a string and cuts the rest, so a longer string (a long file read or command output) is
 * judged window by window (`windowBounds`) instead of as "changed" by the cut, which failed every run with a long tool result.
 * A string that is not well-formed UTF-16 still counts, as the redactor's repair would change it (each window's repair would
 * also catch it; the check is kept because the kept verdicts hash UTF-8, which would map a lone surrogate to U+FFFD).
 *
 * Cost. The guard checks every string of every request, and a run's history grows with each turn, so the "no secret" verdict
 * on a long string is kept by its SHA-256 together with the redactor's `registeredForms`: the same text is judged once while
 * the registered secrets are the same, and again as soon as one is added. A "secret" verdict is never kept (the request is
 * refused anyway). A request then scans only its new long strings, at most `windowCount(length)` windows each.
 */
export function providerRedactor(r: Redactor, maxVerdicts = MAX_CLEAN_VERDICTS): ProviderRedactor {
  const clean = new Map<string, number>();
  return {
    redact: (t) => r.redactString(t),
    containsSecret: (t) => {
      if (t.length <= SCAN_CHARS) return r.redactString(t) !== t;
      if (!isWellFormedString(t)) return true;
      // The UTF-8 bytes of the whole (well-formed) string: any lossy encoding would let two different strings share a verdict.
      const id = createHash("sha256").update(t, "utf8").digest("hex");
      const forms = r.registeredForms;
      if (clean.get(id) === forms) {
        clean.delete(id);
        clean.set(id, forms);
        return false;
      }
      for (const w of windowsOf(t)) if (r.redactString(w) !== w) return true;
      clean.delete(id);
      clean.set(id, forms);
      if (clean.size > maxVerdicts) clean.delete(clean.keys().next().value as string);
      return false;
    },
  };
}

/** The redactor reads at most this many characters of one string. */
const SCAN_CHARS = MAX_STRING_CHARS;
/** The longest key the host registers (`providers.ts` refuses any other key before it is registered): the vault's own rule. */
export const KEY_RULE = /^[\x21-\x7e]{8,4096}$/;
/**
 * The longest form of a registered key the redactor matches: a key is at most 4096 printable ASCII characters (`KEY_RULE`),
 * and its URL-encoded form (the longest of the raw, JSON-escaped, URL-encoded, base64 and hex forms) at most three times that.
 */
export const MAX_KEY_FORM_CHARS = 12_288;
/** How far a window edge may move to stand on a real boundary (S1 of review composer-c7 r1). */
export const EDGE_SEARCH = 256;
/**
 * The distance between window starts: the overlap left after both edges of a window moved by up to `EDGE_SEARCH` plus one
 * (a surrogate pair) still holds a whole key form.
 */
const STEP = SCAN_CHARS - MAX_KEY_FORM_CHARS - 2 * (EDGE_SEARCH + 1);
/** Windows one scan of a string of `length` characters reads. */
export const windowCount = (length: number): number => (length <= SCAN_CHARS ? 1 : Math.ceil((length - SCAN_CHARS) / STEP) + 1);
/** The distance between window starts, exported for the tests. */
export const WINDOW_STEP = STEP;
const MARK = placeholder("registered-secret");

const marks = (s: string): number => s.split(MARK).length - 1;

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;
const isSpace = (c: number): boolean => c === 0x20 || (c >= 0x09 && c <= 0x0d);
/** Not a `\w` character (the redactor's rules anchor on `\b`), and not the first half of a surrogate pair. */
const isBreak = (c: number): boolean => !((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || isHigh(c));

/**
 * A boundary near `at` where the text on both sides is what the full string has: the character just before it (`before`) is
 * whitespace, else any non-word character, searched over at most `EDGE_SEARCH` positions in the direction `dir` (+1 moves
 * right, -1 left). A window edge on such a boundary makes the redactor's `\b` and token rules see what they would see in
 * the whole string: a window that started inside `task-runner` would otherwise read `sk-runner...` as a key. When there is
 * none (a token longer than the search), the edge stays where it is, moved off a surrogate pair: the check may then fail
 * closed on that token, never open.
 */
function boundaryNear(text: string, at: number, dir: 1 | -1): number {
  for (const ok of [isSpace, isBreak]) {
    for (let d = 0; d <= EDGE_SEARCH; d++) {
      const i = at + dir * d;
      if (i <= 0 || i >= text.length) break;
      if (ok(text.charCodeAt(i - 1))) return i;
    }
  }
  return isLow(text.charCodeAt(at)) && isHigh(text.charCodeAt(at - 1)) ? at + (dir === 1 ? 1 : -1) : at;
}

/**
 * `text` in windows of at most `SCAN_CHARS` that overlap by at least `MAX_KEY_FORM_CHARS`: a registered key form, and every
 * pattern rule's anchored match with its context, lies wholly inside one window. Each inner edge stands on a real boundary
 * (`boundaryNear`): a window start moves right and a window end moves left, so a window never grows, never splits a surrogate
 * pair, and never invents a word boundary. Base64 runs longer than the redactor decodes (4,096) are cut where a window and the
 * redactor's own run limit fall (review c7 N4); the windows only add alignments. The bounds `[start, end)`, exported for tests.
 */
export function* windowBounds(text: string): Generator<readonly [number, number]> {
  for (let i = 0; ; i += STEP) {
    const last = i + SCAN_CHARS >= text.length;
    const start = i === 0 ? 0 : boundaryNear(text, i, 1);
    const end = last ? text.length : boundaryNear(text, i + SCAN_CHARS, -1);
    yield [start, end];
    if (last) return;
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
