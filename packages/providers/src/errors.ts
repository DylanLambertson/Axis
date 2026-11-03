// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { makeError, type AxisError, type ErrorCode } from "@axis/protocol";
import { FEATURES, type Feature } from "./types.js";

/**
 * The closed provider error taxonomy. Every adapter maps every failure to one
 * of these codes; anything else that escapes an adapter is treated as
 * `internal` by the guard (`guard.ts`).
 */
export const PROVIDER_ERROR_CODES = [
  "invalid_request",
  "authentication",
  "permission_denied",
  "not_found",
  "rate_limited",
  "overloaded",
  "server_error",
  "timeout",
  "network",
  "cancelled",
  "context_length_exceeded",
  "unsupported_capability",
  "invalid_response",
  "budget_exceeded",
  "secret_in_request",
  "internal",
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

interface CodeInfo {
  /** Whether the same request may be retried, with bounded, jittered backoff. */
  readonly retryable: boolean;
  /** The bridge error code (ADR 0003 D3) this maps to. */
  readonly axis: ErrorCode;
  /** Fixed, user-safe text. Messages are never built from provider bodies (ANT-1). */
  readonly text: string;
}

const CODE_INFO: Readonly<Record<ProviderErrorCode, CodeInfo>> = {
  invalid_request: { retryable: false, axis: "E_INVALID_ARGUMENT", text: "The provider rejected the request as invalid." },
  authentication: { retryable: false, axis: "E_UNAUTHENTICATED", text: "The provider rejected the connection credential." },
  permission_denied: { retryable: false, axis: "E_UNAUTHENTICATED", text: "The credential is not permitted to use this resource." },
  not_found: { retryable: false, axis: "E_NOT_FOUND", text: "The provider does not know this model or resource." },
  rate_limited: { retryable: true, axis: "E_BACKPRESSURE", text: "The provider rate limit was reached." },
  overloaded: { retryable: true, axis: "E_UNAVAILABLE", text: "The provider is overloaded." },
  server_error: { retryable: true, axis: "E_UNAVAILABLE", text: "The provider returned a server error." },
  timeout: { retryable: true, axis: "E_TIMEOUT", text: "The provider request timed out." },
  network: { retryable: true, axis: "E_UNAVAILABLE", text: "The provider could not be reached." },
  cancelled: { retryable: false, axis: "E_CANCELLED", text: "The provider request was cancelled." },
  context_length_exceeded: { retryable: false, axis: "E_INVALID_ARGUMENT", text: "The request exceeds the model context window." },
  unsupported_capability: { retryable: false, axis: "E_INVALID_ARGUMENT", text: "The model does not support a feature this request uses." },
  invalid_response: { retryable: false, axis: "E_INTERNAL", text: "The provider response was malformed or exceeded a limit." },
  budget_exceeded: { retryable: false, axis: "E_POLICY_DENIED", text: "The run budget is exhausted." },
  secret_in_request: { retryable: false, axis: "E_POLICY_DENIED", text: "The request contains a stored credential and was not sent." },
  internal: { retryable: false, axis: "E_INTERNAL", text: "The provider adapter failed." },
};

const CODE_SET: ReadonlySet<string> = new Set(PROVIDER_ERROR_CODES);

export function isProviderErrorCode(code: unknown): code is ProviderErrorCode {
  return typeof code === "string" && CODE_SET.has(code);
}

export function isRetryableCode(code: ProviderErrorCode): boolean {
  return CODE_INFO[code].retryable;
}

export function defaultMessage(code: ProviderErrorCode): string {
  return CODE_INFO[code].text;
}

/** Short machine-readable detail. Only these keys may ride on an error. */
export interface ProviderErrorDetails {
  /** HTTP status, when the failure came from one. */
  readonly status?: number;
  /** Server-advised delay before a retry, in milliseconds. */
  readonly retryAfterMs?: number;
  /** A fixed reason word (lowercase letters and `_`, at most 32), for example the budget dimension that ran out. */
  readonly reason?: string;
  /** The capability a request used and the model lacks; one of `FEATURES`. */
  readonly capability?: Feature;
}

export interface ProviderErrorInit extends ProviderErrorDetails {
  /** Overrides the fixed text. Must be user-safe; never a provider body. */
  readonly message?: string;
}

/**
 * Reasons are fixed words chosen by code, never data. No digits and a short
 * bound keep a credential (or a prefix of one) from passing as a reason.
 */
const REASON_RE = /^[a-z][a-z_]{0,31}$/;
const FEATURE_SET: ReadonlySet<string> = new Set(FEATURES);

export const DETAIL_KEYS = ["status", "retryAfterMs", "reason", "capability"] as const;

/**
 * The one error type adapters throw. It has no `cause`: a cause chain is where
 * request bodies and credentials leak into logs (ANT-1, PRV-2). Instances are
 * frozen, so nothing can be attached after construction. The guard never
 * trusts an adapter's instance anyway: it rebuilds a fresh one
 * (`sanitizeProviderError` in `guard.ts`).
 */
export class ProviderError extends Error {
  override readonly name = "ProviderError";
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly details: ProviderErrorDetails;

  constructor(code: ProviderErrorCode, init: ProviderErrorInit = {}) {
    super(init.message ?? CODE_INFO[code].text);
    this.code = code;
    this.retryable = CODE_INFO[code].retryable;
    const details: { -readonly [K in keyof ProviderErrorDetails]: ProviderErrorDetails[K] } = {};
    if (init.status !== undefined && Number.isInteger(init.status) && init.status >= 100 && init.status <= 599) {
      details.status = init.status;
    }
    if (init.retryAfterMs !== undefined && Number.isFinite(init.retryAfterMs) && init.retryAfterMs >= 0) {
      details.retryAfterMs = Math.min(Math.round(init.retryAfterMs), 86_400_000);
    }
    if (typeof init.reason === "string" && REASON_RE.test(init.reason)) details.reason = init.reason;
    if (typeof init.capability === "string" && FEATURE_SET.has(init.capability)) details.capability = init.capability;
    this.details = Object.freeze(details);
    Object.freeze(this);
  }

  toJSON(): { name: string; code: ProviderErrorCode; message: string; retryable: boolean; details: ProviderErrorDetails } {
    return { name: this.name, code: this.code, message: this.message, retryable: this.retryable, details: this.details };
  }
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError;
}

/**
 * Map a provider error to the bridge error shape. The message is the error's
 * own (already user-safe) text; details carry only the fixed fields above.
 */
export function toAxisError(e: ProviderError, correlationId: string): AxisError {
  // Copy the known keys only, each type-checked: `details` is not trusted to
  // have the shape the type says (B1).
  const d = e.details;
  const details: Record<string, string | number> = { providerCode: e.code };
  if (typeof d.status === "number" && Number.isInteger(d.status)) details["status"] = d.status;
  if (typeof d.retryAfterMs === "number" && Number.isFinite(d.retryAfterMs)) details["retryAfterMs"] = d.retryAfterMs;
  if (typeof d.reason === "string" && REASON_RE.test(d.reason)) details["reason"] = d.reason;
  if (typeof d.capability === "string" && FEATURE_SET.has(d.capability)) details["capability"] = d.capability;
  return makeError(CODE_INFO[e.code].axis, e.message, correlationId, details);
}

export function axisCodeFor(code: ProviderErrorCode): ErrorCode {
  return CODE_INFO[code].axis;
}

/** Map an HTTP status to the taxonomy, for HTTP adapters (ticket 9 and later). */
export function codeForHttpStatus(status: number): ProviderErrorCode {
  switch (status) {
    case 400:
    case 422:
      return "invalid_request";
    case 401:
      return "authentication";
    case 403:
      return "permission_denied";
    case 404:
      return "not_found";
    case 408:
      return "timeout";
    case 413:
      return "context_length_exceeded";
    case 429:
      return "rate_limited";
    case 503:
    case 529:
      return "overloaded";
    default:
      return status >= 500 && status <= 599 ? "server_error" : "invalid_response";
  }
}

/** Longest message an error may carry after sanitizing. */
export const MAX_PROVIDER_ERROR_MESSAGE = 1_024;
/** Redaction runs over at most this much of a message, so a huge message cannot stall it. */
const MESSAGE_PRECAP = 16_384;

/** Cut at a UTF-16 length without splitting a surrogate pair. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const last = s.charCodeAt(max - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** Read one property without letting a throwing getter escape. */
function read(o: object, key: string): unknown {
  try {
    return (o as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** The part of a redactor `sanitizeProviderError` needs. */
export interface ErrorRedactor {
  redact(text: string): string;
  containsSecret(text: string): boolean;
}

/**
 * Build a fresh, safe `ProviderError` from anything an adapter threw (B1).
 * The adapter's object is never returned: extra properties, a `cause`, a
 * replaced `details` object and getters stay behind. Each field is read once,
 * the message is bounded and redacted, and `reason` is dropped if it holds a
 * secret. A value that is not a `ProviderError` becomes a fixed `internal`.
 */
export function sanitizeProviderError(e: unknown, redactor: ErrorRedactor): ProviderError {
  if (!(e instanceof ProviderError)) return new ProviderError("internal");
  const rawCode = read(e, "code");
  const code: ProviderErrorCode = isProviderErrorCode(rawCode) ? rawCode : "internal";
  const rawMessage = read(e, "message");
  let message = typeof rawMessage === "string" ? truncate(rawMessage, MESSAGE_PRECAP) : defaultMessage(code);
  message = redactor.redact(message);
  if (message.length > MAX_PROVIDER_ERROR_MESSAGE) message = `${truncate(message, MAX_PROVIDER_ERROR_MESSAGE - 1)}…`;
  const rawDetails = read(e, "details");
  const d = typeof rawDetails === "object" && rawDetails !== null ? rawDetails : {};
  const status = read(d, "status");
  const retryAfterMs = read(d, "retryAfterMs");
  const reason = read(d, "reason");
  const capability = read(d, "capability");
  const init: { -readonly [K in keyof ProviderErrorInit]: ProviderErrorInit[K] } = { message };
  if (typeof status === "number") init.status = status;
  if (typeof retryAfterMs === "number") init.retryAfterMs = retryAfterMs;
  if (typeof reason === "string" && !redactor.containsSecret(reason)) init.reason = reason;
  if (typeof capability === "string" && FEATURE_SET.has(capability)) init.capability = capability as Feature;
  return new ProviderError(code, init);
}
