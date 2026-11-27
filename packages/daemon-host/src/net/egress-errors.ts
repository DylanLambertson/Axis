// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/*
 * The egress client's closed errors (ticket PV-N1d slice B; ADR 0009 decision 4). Every failure is one of these codes with
 * a fixed message, plus the HTTP status where there is one. Nothing a caller passed or a server sent (a URL, a header, a
 * body, a `Location`, a resolver or TLS message) is ever part of an error: the constructor takes a code and a number only.
 */

export const EGRESS_ERROR_TEXT = {
  request_refused: "the request is malformed",
  not_authorized: "the request carries no valid, unspent authorization",
  method_refused: "the request method is not allowed",
  target_refused: "the request target is not an allowed origin",
  header_refused: "a request header is not allowed",
  request_too_large: "the request body is over its cap",
  busy: "too many requests are in flight for this integration",
  rate_limited: "the service asked to wait before the next request",
  address_refused: "the host resolved to an address that is not public",
  unresolved: "the host did not resolve",
  tls_failed: "the TLS connection or certificate check failed",
  connect_failed: "the connection failed",
  first_byte_timeout: "no response within 10 seconds",
  total_timeout: "the response did not complete within 30 seconds",
  redirect_refused: "the service answered with a redirect, which is not followed",
  encoding_refused: "the response is encoded; only identity is accepted",
  response_headers_too_large: "the response headers are over their cap",
  response_too_large: "the response body is over its cap",
  json_too_deep: "the response JSON is nested too deeply",
  json_invalid: "the response is not valid JSON",
  http_status: "the service answered with an error status",
  aborted: "the request was cancelled",
} as const;

export type EgressErrorCode = keyof typeof EGRESS_ERROR_TEXT;

export class EgressError extends Error {
  readonly code: EgressErrorCode;
  /** The HTTP status for `http_status`, `rate_limited` and `redirect_refused` answers; otherwise undefined. */
  readonly status: number | undefined;
  /** Whole seconds to wait, for `rate_limited`. */
  readonly retryAfterSeconds: number | undefined;

  constructor(code: EgressErrorCode, status?: number, retryAfterSeconds?: number) {
    const s = Number.isInteger(status) ? (status as number) : undefined;
    super(s === undefined ? EGRESS_ERROR_TEXT[code] : `${EGRESS_ERROR_TEXT[code]} (status ${s})`);
    this.name = "EgressError";
    this.code = code;
    this.status = s;
    this.retryAfterSeconds = Number.isInteger(retryAfterSeconds) ? retryAfterSeconds : undefined;
  }
}

/** The closed error for a Node socket or TLS failure: the code is read, the message (which may echo a host) never is. */
export function socketError(e: unknown): EgressError {
  if (e instanceof EgressError) return e;
  const code = typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "";
  if (code === "HPE_HEADER_OVERFLOW") return new EgressError("response_headers_too_large");
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NODATA" || code === "EAI_NONAME") return new EgressError("unresolved");
  if (code === "ABORT_ERR") return new EgressError("aborted");
  if (code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_") || code.includes("CERT") || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    return new EgressError("tls_failed");
  }
  return new EgressError("connect_failed");
}
