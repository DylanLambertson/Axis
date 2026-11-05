// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { GitOpsError, redactUrls, sanitizeText } from "@axis/git-ops";
import type { ErrorCode } from "@axis/protocol";

export type ReviewDetails = Readonly<Record<string, string | number | boolean>>;

/**
 * A refusal with a code from the closed @axis/protocol set. The message and details are plain primitives written by
 * this package; nothing is carried from git's output except a sanitised, truncated string, and there is no `cause`.
 */
export class ReviewError extends Error {
  readonly code: ErrorCode;
  readonly details: ReviewDetails | undefined;
  constructor(code: ErrorCode, message: string, details?: ReviewDetails) {
    super(message);
    this.name = "ReviewError";
    this.code = code;
    this.details = details === undefined ? undefined : Object.freeze({ ...details });
  }
}

export const invalid = (message: string, reason?: string): ReviewError =>
  new ReviewError("E_INVALID_ARGUMENT", message, reason === undefined ? undefined : { reason });
export const conflict = (message: string, reason: string, extra: ReviewDetails = {}): ReviewError =>
  new ReviewError("E_CONFLICT", message, { ...extra, reason });
export const denied = (message: string, reason?: string): ReviewError =>
  new ReviewError("E_POLICY_DENIED", message, reason === undefined ? undefined : { reason });
export const unavailable = (message: string): ReviewError => new ReviewError("E_UNAVAILABLE", message);
export const notFound = (message: string): ReviewError => new ReviewError("E_NOT_FOUND", message);
export const internal = (message: string): ReviewError => new ReviewError("E_INTERNAL", message);

/** Short, safe text from git's stderr for a message: no escapes or control characters, no URL credentials. */
export function stderrSnippet(stderr: string): string {
  return redactUrls(sanitizeText(stderr)).trim().slice(0, 300);
}

/**
 * Runs an operation so that only ReviewError leaves the package. A refusal from @axis/git-ops keeps its code; anything
 * else (a spawn failure, a throwing hook) becomes E_UNAVAILABLE with a fixed message and, at most, a short error code
 * such as ENOENT, because the original text may carry paths or content.
 */
export async function mapUnexpected<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw classify(e);
  }
}

/** Never throws, whatever the thrown value is: a getter or a Proxy that throws while being inspected is just "unknown". */
function classify(e: unknown): ReviewError {
  try {
    if (e instanceof ReviewError) return e;
    if (e instanceof GitOpsError) return new ReviewError(e.code, e.message, e.details);
    const code = (e as { code?: unknown } | null)?.code;
    return unavailable(`git could not be run${typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? ` (${code})` : ""}`);
  } catch {
    return unavailable("git could not be run");
  }
}
