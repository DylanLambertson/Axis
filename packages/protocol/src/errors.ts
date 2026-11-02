// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import { approvalRequiredDetailsSchema } from "./challenge.js";
import { boundedJsonSchema, type JsonValue } from "./limits.js";

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
export const MAX_ERROR_DETAILS_KEYS = 16;

export const errorSchema = z
  .strictObject({
  code: errorCodeSchema,
  message: z.string().max(MAX_ERROR_MESSAGE),
  retryable: z.boolean(),
  correlationId: z.string().min(1).max(64),
  /** At most 16 keys, each a bounded JSON value; contracts may narrow it further. */
  details: z
    .record(z.string().max(64), boundedJsonSchema)
    .refine((d) => Object.keys(d).length <= MAX_ERROR_DETAILS_KEYS, "too many detail keys")
    .optional(),
  })
  .refine(
    (e) => e.code !== "E_APPROVAL_REQUIRED" || approvalRequiredDetailsSchema.safeParse(e.details).success,
    { message: "E_APPROVAL_REQUIRED must carry a challenge in details", path: ["details"] },
  );
export type AxisError = z.infer<typeof errorSchema>;

export function makeError(
  code: ErrorCode,
  message: string,
  correlationId: string,
  details?: Record<string, JsonValue>,
): AxisError {
  const base = {
    code,
    message: truncate(message, MAX_ERROR_MESSAGE),
    retryable: RETRYABLE_CODES.has(code),
    correlationId,
  };
  return details === undefined ? base : { ...base, details };
}

/** Cut at a UTF-16 length without splitting a surrogate pair. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const last = s.charCodeAt(max - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}
