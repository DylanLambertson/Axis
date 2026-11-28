// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError } from "@axis/daemon";
import { reviewDiffReasonSchema } from "@axis/protocol";
import { ReviewRefusal } from "../ports/review.js";

/** The fixed refusals of the `axis.review/1` handlers: every text is a constant, never a path, an id or git's output. */
export const NOT_AVAILABLE = "This review is not available.";
type Code = "E_CANCELLED" | "E_INTERNAL" | "E_NOT_FOUND" | "E_CONFLICT" | "E_INVALID_ARGUMENT" | "E_UNAVAILABLE";

export function fail(code: Code, message: string, reason?: string): never {
  throw new DaemonError(code, message, reason === undefined ? undefined : { reason });
}

/** A method's closed reason set: anything a refusal carries outside it is dropped. */
export interface ReasonSet {
  safeParse(value: unknown): { readonly success: true; readonly data: string } | { readonly success: false };
}

/** The closed `reason` of a refusal, or undefined for anything outside the wire's set. */
function reasonOf(e: ReviewRefusal, reasons: ReasonSet): string | undefined {
  const r = reasons.safeParse(e.reason);
  return r.success ? r.data : undefined;
}

/** `reasons`: the calling method's closed set (`diff`'s by default; `hunks` and `build` pass their own). */
export function mapRefusal(e: unknown, reasons: ReasonSet = reviewDiffReasonSchema): never {
  if (e instanceof DaemonError) throw e;
  if (e instanceof ReviewRefusal) {
    const reason = reasonOf(e, reasons);
    switch (e.code) {
      case "E_INVALID_ARGUMENT":
        return fail("E_INVALID_ARGUMENT", reason === "too_large" ? "There are too many changed files to review at once." : "The review request is invalid.", reason);
      case "E_NOT_FOUND":
        return fail("E_NOT_FOUND", "The workspace was not found.");
      case "E_CANCELLED":
        return fail("E_CANCELLED", "The request was cancelled.");
      case "E_INTERNAL":
        return fail("E_INTERNAL", "The review could not be completed.");
      // A handler cannot raise E_POLICY_DENIED: a review the package would not build is a conflict with the state.
      case "E_CONFLICT":
      case "E_POLICY_DENIED":
        return fail("E_CONFLICT", "The workspace cannot be reviewed in its current state.", reason);
      default:
        return fail("E_UNAVAILABLE", "The review could not be completed.");
    }
  }
  return fail("E_UNAVAILABLE", "The review could not be completed.");
}
