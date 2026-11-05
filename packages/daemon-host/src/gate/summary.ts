// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { shortenSummary } from "./pending-registry.js";

/** What the native dialog may show: no control, format (bidi, zero-width), surrogate or line-separator characters. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;
export const NATIVE_SUMMARY_MAX = 192;
const DETAIL_MAX = 80;

/**
 * The one line the native dialog shows (APR-2): which action, then what it is applied to. The action is the policy
 * table's key for the method (`axis.worktrees/1.remove`), so the dialog says what is being confirmed whatever the
 * renderer showed. The detail is a short display text a content hook produced from a name the USER chose (a workspace or
 * project display name) when it gave one, else the challenge's own target summary. It must never carry text an agent
 * or a repository wrote (a plan or finding summary could say "read only, safe to confirm"), and it is never built
 * from the raw payload. A detail with an unsafe character is replaced by the target summary; runs of spaces collapse to
 * one; it is cut at 80 code units, and the whole line at 192, with the action always kept whole.
 */
export function nativeSummary(action: string, targetSummary: string, detail?: string): string {
  const clean = detail === undefined ? "" : detail.replace(/\p{Z}+/gu, " ").trim();
  const safe = clean.length > 0 && !UNSAFE.test(clean) ? shortenSummary(clean, DETAIL_MAX) : targetSummary;
  const prefix = `${action}: `;
  if (prefix.length >= NATIVE_SUMMARY_MAX - 8) return shortenSummary(action, NATIVE_SUMMARY_MAX);
  return prefix + shortenSummary(safe, NATIVE_SUMMARY_MAX - prefix.length);
}
