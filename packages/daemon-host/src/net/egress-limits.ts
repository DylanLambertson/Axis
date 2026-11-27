// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { INTEGRATION_REQUEST_MAX_BYTES, INTEGRATION_RESPONSE_HEADERS_MAX_BYTES, INTEGRATION_RESPONSE_MAX_BYTES, INTEGRATION_RESPONSE_MAX_DEPTH } from "@axis/protocol";
import { EgressError } from "./egress-errors.js";

/*
 * The egress client's caps and rate rules (ticket PV-N1d slice B; ADR 0009 decision 4), as pure code with an injected
 * clock: no socket and no timer here, so every rule is tested without a network or a wait.
 */

export const EGRESS_LIMITS = Object.freeze({
  requestBytes: INTEGRATION_REQUEST_MAX_BYTES,
  responseBytes: INTEGRATION_RESPONSE_MAX_BYTES,
  responseHeaderBytes: INTEGRATION_RESPONSE_HEADERS_MAX_BYTES,
  jsonDepth: INTEGRATION_RESPONSE_MAX_DEPTH,
  firstByteMs: 10_000,
  totalMs: 30_000,
  inFlightPerIntegration: 4,
  maxBackoffSeconds: 900,
});

/**
 * Request headers the client owns. A caller may not set them: the client sends no `Accept-Encoding`, computes the length,
 * names the host from the checked target and never uses a proxy or an upgrade.
 */
export const CLIENT_OWNED_HEADERS: ReadonlySet<string> = new Set([
  "host", "content-length", "transfer-encoding", "accept-encoding", "authorization", "connection", "keep-alive", "upgrade", "te", "trailer",
  "expect", "proxy-authorization", "proxy-connection",
]);

/** The caller's headers with lower-case names, or `header_refused` for a client-owned or malformed one. */
export function requestHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out = Object.create(null) as Record<string, string>; // a fresh null-prototype record: own pairs only, read once
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    // The token rule on the name AS GIVEN, before lower-casing: U+212A (Kelvin) lower-cases to "k" (review 3 nit 3).
    if (typeof name !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new EgressError("header_refused");
    const n = name.toLowerCase();
    if (CLIENT_OWNED_HEADERS.has(n) || n.startsWith("proxy-") || seen.has(n)) throw new EgressError("header_refused");
    seen.add(n);
    if (typeof value !== "string" || /[^\t\x20-\x7e]/.test(value)) throw new EgressError("header_refused");
    out[n] = value;
  }
  return out;
}

/** Refuses a request body over its cap before anything is sent. */
export function checkRequestBody(body: Uint8Array | undefined): void {
  if (body !== undefined && body.byteLength > EGRESS_LIMITS.requestBytes) throw new EgressError("request_too_large");
}

/** Only `identity` (or no header) is accepted; any other `Content-Encoding` is refused, so the caps measure decoded bytes. */
export function checkContentEncoding(value: string | string[] | undefined): void {
  if (value === undefined) return;
  const v = Array.isArray(value) ? value.join(",") : value;
  if (v.trim().toLowerCase() !== "identity") throw new EgressError("encoding_refused");
}

/** Collects a response body; over the cap it fails and keeps nothing, so a truncated body is never returned. */
export class BodyCollector {
  private chunks: Buffer[] = [];
  private size = 0;
  add(chunk: Buffer): void {
    this.size += chunk.byteLength;
    if (this.size > EGRESS_LIMITS.responseBytes) {
      this.chunks = [];
      throw new EgressError("response_too_large");
    }
    this.chunks.push(chunk);
  }
  body(): Buffer {
    return Buffer.concat(this.chunks, this.size);
  }
}

/** The JSON nesting depth of `text` (strings skipped), stopping as soon as it passes `limit`. */
export function jsonDepthOver(text: string, limit: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++; // backslash: skip the escaped character
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) {
      if (++depth > limit) return true;
    } else if (c === 0x7d || c === 0x5d) depth--;
  }
  return false;
}

/** The body as JSON: valid UTF-8, nesting within the cap (checked before parsing), then parsed. Closed errors only. */
export function parseJsonBody(body: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new EgressError("json_invalid");
  }
  if (jsonDepthOver(text, EGRESS_LIMITS.jsonDepth)) throw new EgressError("json_too_deep");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new EgressError("json_invalid");
  }
}

/** `Retry-After` as whole seconds: digits only (an HTTP date or any other form is ignored), capped at the backoff cap. */
export function parseRetryAfter(value: string | string[] | undefined): number | undefined {
  if (typeof value !== "string" || !/^[0-9]{1,10}$/.test(value.trim())) return undefined;
  return Math.min(Number(value.trim()), EGRESS_LIMITS.maxBackoffSeconds);
}

/** Per-integration state: requests in flight and the time before which no request is sent. `now` is injected (ms). */
export class IntegrationGate {
  private readonly inFlight = new Map<string, number>();
  private readonly notBefore = new Map<string, number>();
  private readonly strikes = new Map<string, number>();
  constructor(private readonly now: () => number) {}

  /** Takes a slot, or refuses: `rate_limited` while backing off, `busy` at the in-flight cap. Returns the release. */
  enter(integration: string): () => void {
    const wait = (this.notBefore.get(integration) ?? 0) - this.now();
    if (wait > 0) throw new EgressError("rate_limited", undefined, Math.ceil(wait / 1000));
    const n = this.inFlight.get(integration) ?? 0;
    if (n >= EGRESS_LIMITS.inFlightPerIntegration) throw new EgressError("busy");
    this.inFlight.set(integration, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.inFlight.get(integration) ?? 1) - 1;
      if (left > 0) this.inFlight.set(integration, left);
      else this.inFlight.delete(integration);
    };
  }

  /**
   * Records a 429 or 503: wait `Retry-After` seconds when it is an integer, otherwise 2^(strikes) seconds; either way at
   * most 15 minutes. Returns the seconds chosen.
   */
  backOff(integration: string, retryAfter: number | undefined): number {
    const strikes = (this.strikes.get(integration) ?? 0) + 1;
    this.strikes.set(integration, strikes);
    const seconds = Math.min(retryAfter ?? 2 ** Math.min(strikes, 10), EGRESS_LIMITS.maxBackoffSeconds);
    this.notBefore.set(integration, this.now() + seconds * 1000);
    return seconds;
  }

  /** A successful answer clears the strikes. */
  succeeded(integration: string): void {
    this.strikes.delete(integration);
  }
}
