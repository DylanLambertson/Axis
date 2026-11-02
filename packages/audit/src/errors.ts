// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * Closed set of structured error codes (ADR 0003, "Structured errors"). This
 * package and `@axis/journal` use a subset; the set is mirrored here rather
 * than invented so the bridge can pass errors through unchanged.
 */
export const ERROR_CODES = [
  "E_INVALID_ARGUMENT",
  "E_UNAUTHENTICATED",
  "E_POLICY_DENIED",
  "E_APPROVAL_REQUIRED",
  "E_NOT_FOUND",
  "E_CONFLICT",
  "E_IDEMPOTENCY_CONFLICT",
  "E_TIMEOUT",
  "E_CANCELLED",
  "E_BACKPRESSURE",
  "E_UNAVAILABLE",
  "E_METHOD_NOT_FOUND",
  "E_VERSION_UNSUPPORTED",
  "E_INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * A structured error. `message` must be user-safe: callers never put secrets,
 * payloads or stack traces in it. `detail` carries small machine-readable
 * facts (for example the first bad sequence number).
 */
export class AxisError extends Error {
  readonly code: ErrorCode;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: ErrorCode,
    message: string,
    detail: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(message);
    this.name = "AxisError";
    this.code = code;
    this.detail = detail;
  }
}
