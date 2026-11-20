// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { MAX_STRING_CHARS, placeholder, type Redactor } from "@axis/audit";
import type { Redactor as ProviderRedactor } from "@axis/providers";

/**
 * The host redactor as the providers' redaction hook, and the check for a registered secret in provider output. Kept
 * apart from `providers.ts` so the agent binding (the mock's guard) does not load the vault or the adapter (review c6 N6).
 */

/** The host's audit redactor as the providers' redaction hook (PRV-2): anything it would change counts as a secret. */
export function providerRedactor(r: Redactor): ProviderRedactor {
  return { redact: (t) => r.redactString(t), containsSecret: (t) => r.redactString(t) !== t };
}

/** The redactor reads at most this many characters of one string. */
const SCAN_CHARS = MAX_STRING_CHARS;
/**
 * The longest form of a registered key the redactor matches: a key is at most 4096 printable characters, and its
 * URL-encoded form (the longest of the raw, JSON-escaped, URL-encoded, base64 and hex forms) at most three times that.
 */
export const MAX_KEY_FORM_CHARS = 12_288;
const STEP = SCAN_CHARS - MAX_KEY_FORM_CHARS;
const MARK = placeholder("registered-secret");

const marks = (s: string): number => s.split(MARK).length - 1;

/**
 * True when `text` holds a secret registered with the host redactor (a vault key once read), in any form the redactor
 * knows. Only registered secrets count: a pattern rule's match (an example key in an answer) does not. Long text is
 * scanned in overlapping windows, so a form up to `MAX_KEY_FORM_CHARS` long is never split between two of them.
 */
export function holdsRegisteredSecret(r: Redactor, text: string): boolean {
  for (let i = 0; ; i += STEP) {
    const w = text.slice(i, i + SCAN_CHARS);
    if (marks(r.redactString(w)) > marks(w)) return true;
    if (i + SCAN_CHARS >= text.length) return false;
  }
}
