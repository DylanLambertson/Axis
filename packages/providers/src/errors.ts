// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { makeError, type AxisError, type ErrorCode } from "@axis/protocol";

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
  /** A fixed reason word, for example the budget dimension that ran out. */
  readonly reason?: string;
  /** The capability a request used and the model lacks. */
  readonly capability?: string;
}

export interface ProviderErrorInit extends ProviderErrorDetails {
  /** Overrides the fixed text. Must be user-safe; never a provider body. */
  readonly message?: string;
}

const REASON_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * The one error type adapters throw. It has no `cause`: a cause chain is where
 * request bodies and credentials leak into logs (ANT-1, PRV-2).
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
    if (init.reason !== undefined && REASON_RE.test(init.reason)) details.reason = init.reason;
    if (init.capability !== undefined && REASON_RE.test(init.capability)) details.capability = init.capability;
    this.details = Object.freeze(details);
  }

  /** The same error with its message replaced, for example after redaction. */
  withMessage(message: string): ProviderError {
    return new ProviderError(this.code, { ...this.details, message });
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
  const details: Record<string, string | number> = { providerCode: e.code };
  for (const [k, v] of Object.entries(e.details)) {
    if (typeof v === "string" || typeof v === "number") details[k] = v;
  }
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
