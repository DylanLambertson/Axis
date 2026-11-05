// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { ProviderError, type ProviderErrorCode } from "@axis/providers";
import { parseJson, readText } from "./json.js";
import type { AnthropicLimits } from "./limits.js";
import { BodyStream, type ResponseLike } from "./transport.js";

/** The HTTP status to taxonomy table (design §8). The body does not decide it. */
export function codeForStatus(status: number): ProviderErrorCode {
  switch (status) {
    case 401:
      return "authentication";
    case 402:
    case 403:
      return "permission_denied";
    case 404:
      return "not_found";
    case 408:
    case 504:
      return "timeout";
    case 413:
      // request_too_large: the body exceeded the byte limit, not the context window (N4).
      return "invalid_request";
    case 429:
      return "rate_limited";
    case 503:
    case 529:
      return "overloaded";
    default:
      if (status >= 500 && status <= 599) return "server_error";
      if (status >= 400 && status <= 499) return "invalid_request";
      return "invalid_response";
  }
}

/** Only a whole number of seconds is honoured; a date or garbage is ignored. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^[0-9]{1,7}$/.test(value.trim())) return undefined;
  return Number(value.trim()) * 1_000;
}

/**
 * Build the error for a non-200 response. At most `maxErrorBodyBytes` of the
 * body are read, and only to see whether a 400 says the prompt is too long;
 * the body is never surfaced. The status and a `Retry-After` header are the
 * only things that reach the error.
 */
export async function errorFromResponse(res: ResponseLike, signal: AbortSignal, limits: AnthropicLimits): Promise<ProviderError> {
  let code = codeForStatus(res.status);
  const retryAfter = res.status === 429 || res.status === 503 || res.status === 529 ? parseRetryAfter(safeHeader(res, "retry-after")) : undefined;
  if (code === "invalid_request" && res.status === 400 && res.body !== null) {
    const body = new BodyStream(res.body, signal, Number.MAX_SAFE_INTEGER);
    try {
      const text = await readText(body, limits.maxErrorBodyBytes, true);
      if (looksLikePromptTooLong(text, limits)) code = "context_length_exceeded";
    } catch (e) {
      if (e instanceof ProviderError && e.code === "cancelled") throw e;
      // An unreadable error body changes nothing: the status alone decides.
    } finally {
      await body.close();
    }
  } else if (res.body !== null) {
    const body = new BodyStream(res.body, signal, Number.MAX_SAFE_INTEGER);
    await body.close();
  }
  return new ProviderError(code, {
    status: res.status,
    ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
    ...(res.status === 413 ? { reason: "request_too_large" } : {}),
  });
}

function safeHeader(res: ResponseLike, name: string): string | null {
  try {
    const v = res.headers.get(name);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

function looksLikePromptTooLong(text: string, limits: AnthropicLimits): boolean {
  let json: unknown;
  try {
    json = parseJson(text, limits.maxEventJsonDepth);
  } catch {
    return false;
  }
  if (typeof json !== "object" || json === null) return false;
  const err = (json as Record<string, unknown>)["error"];
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  return e["type"] === "invalid_request_error" && typeof e["message"] === "string" && e["message"].toLowerCase().includes("prompt is too long");
}
