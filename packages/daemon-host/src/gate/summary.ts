// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { shortenSummary } from "./pending-registry.js";

/** What the native dialog may show: no control, format (bidi, zero-width), surrogate or line-separator characters. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;
export const NATIVE_SUMMARY_MAX = 192;

/**
 * The one line the native dialog shows (APR-2): which action, then what it is applied to. The action is the policy
 * table's key for the method (`axis.worktrees/1.remove`), so the dialog says what is being confirmed whatever the
 * renderer showed. The detail is a display text a content hook produced from fields known to be safe (a workspace or
 * project name, a plan or finding summary) when it gave one, else the challenge's own target summary. It is never
 * built from the raw payload. A detail with an unsafe character is replaced by the target summary, and the whole line
 * is cut at 192 code units with the action always kept whole.
 */
export function nativeSummary(action: string, targetSummary: string, detail?: string): string {
  const safe = detail !== undefined && detail.length > 0 && !UNSAFE.test(detail) ? detail : targetSummary;
  const prefix = `${action}: `;
  if (prefix.length >= NATIVE_SUMMARY_MAX - 8) return shortenSummary(action, NATIVE_SUMMARY_MAX);
  return prefix + shortenSummary(safe, NATIVE_SUMMARY_MAX - prefix.length);
}
