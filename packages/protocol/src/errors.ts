// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";

/** The closed set of error codes (ADR 0003 D3). Unknown codes are rejected. */
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

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** Codes a client may retry (with bounded, jittered backoff). */
export const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "E_BACKPRESSURE",
  "E_UNAVAILABLE",
  "E_TIMEOUT",
]);

export const MAX_ERROR_MESSAGE = 1024;

/** Structured error. `message` is user-safe and redacted; stacks never cross the bridge. */
export const errorSchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string().max(MAX_ERROR_MESSAGE),
  retryable: z.boolean(),
  correlationId: z.string().min(1).max(64),
  /** Small JSON object only; contracts may narrow it. */
  details: z.record(z.string().max(64), z.json()).optional(),
});
export type AxisError = z.infer<typeof errorSchema>;

export function makeError(
  code: ErrorCode,
  message: string,
  correlationId: string,
  details?: Record<string, z.core.util.JSONType>,
): AxisError {
  const base = {
    code,
    message: message.slice(0, MAX_ERROR_MESSAGE),
    retryable: RETRYABLE_CODES.has(code),
    correlationId,
  };
  return details === undefined ? base : { ...base, details };
}
