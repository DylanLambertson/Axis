// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { JsonValue } from "@axis/protocol";
import type { ProviderErrorCode } from "../src/errors.js";
import type { ProviderAdapter } from "../src/types.js";

/** Error codes a harness is asked to simulate as provider error responses. */
export const CONTRACT_ERROR_CODES = [
  "invalid_request",
  "authentication",
  "permission_denied",
  "not_found",
  "rate_limited",
  "overloaded",
  "server_error",
  "context_length_exceeded",
] as const satisfies readonly ProviderErrorCode[];
export type ContractErrorCode = (typeof CONTRACT_ERROR_CODES)[number];

/** What the simulated provider does for the next request. */
export type ContractScenario =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "max_tokens"; readonly text: string }
  | { readonly kind: "tool_use"; readonly name: string; readonly input: { readonly [key: string]: JsonValue } }
  /**
   * An error response. The harness must put `canary` and `credential` into
   * the simulated response body and headers, to prove the adapter does not
   * echo them into errors (ANT-1).
   */
  | { readonly kind: "error"; readonly code: ContractErrorCode; readonly retryAfterMs?: number }
  /** A stream that sends `text` and then fails with `overloaded`. */
  | { readonly kind: "mid_stream_error"; readonly text: string }
  /** A response that starts and then sends nothing until cancelled. */
  | { readonly kind: "hang" }
  /** A corrupt response that cannot be parsed. */
  | { readonly kind: "malformed" }
  /**
   * The suite's transport answers every request (model listings, capability
   * lookups and message requests alike) with this redirect status and a
   * `Location` on `REDIRECT_HOST`, which the transport also answers, so an
   * adapter that follows gets a normal 200 back and no error to hide behind.
   * The adapter must not follow (ANT-1). The harness's own handler is not
   * called in this scenario.
   */
  | { readonly kind: "redirect"; readonly status: RedirectStatus };

export const REDIRECT_STATUSES = [301, 302, 303, 307, 308] as const;
export type RedirectStatus = (typeof REDIRECT_STATUSES)[number];

/** The recognizable host every redirect points at. It must never receive a request. */
export const REDIRECT_HOST = "redirect-target.contract.invalid";

/**
 * How long the suite's final check waits, once, after the last test, for a
 * request sent late (in the background, from a timer, from a still-running
 * stream). Each check takes the violations seen so far without waiting, so a
 * late request fails the first check after it arrives, or this final one
 * (SF-1). A process `exit` scan catches anything later still.
 */
export const LATE_REQUEST_WINDOW_MS = 3_000;

/** The `fetch` options the suite's transport understands; Node's `fetch` takes the same. */
export interface ContractFetchInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  /** `fetch` follows redirects unless this is `manual` or `error`; the transport does the same. */
  readonly redirect?: "follow" | "manual" | "error";
  readonly signal?: AbortSignal;
}

/**
 * A `fetch`-shaped function. Generic over the init and response types, so an
 * adapter's own narrower `fetch` type (for example one that always passes
 * `redirect: "manual"` and returns a structural response) can be wrapped
 * without casts. What `wrap` returns answers with the inner function's
 * responses, or with a `Response` in the redirect scenario.
 */
export type ContractFetch<I extends ContractFetchInit = ContractFetchInit, R = Response> = (url: string, init: I) => Promise<R>;

/**
 * The suite's transport, handed to `ContractHarness.setup`. The harness must
 * build its adapter with `wrap(inner)` as the adapter's `fetch`, where `inner`
 * is the harness's fake server. The suite records every request at this seam
 * itself; nothing is taken from the adapter's own account (ANT-1).
 *
 * Bypass detection (N-2), three layers:
 * - During each test `globalThis.fetch` is replaced by a trap. The trap only
 *   catches code that looks `globalThis.fetch` up at call time; a reference
 *   captured earlier (for example at module load) still calls the real fetch.
 * - Node's request diagnostics channels (`undici:request:create`, which the
 *   built-in fetch uses, and `http.client.request.start` for `node:http` and
 *   `node:https`) are watched for the whole suite run. The suite's transport
 *   and every harness fake make no real request, so any request there is a
 *   violation: this catches a captured fetch and direct `node:https` I/O.
 * - For an adapter with an origin, at least one transport request per
 *   provider request.
 * Harnesses must therefore never perform real network I/O, not even to a
 * local server, while the suite runs.
 */
export interface ContractTransport {
  wrap<I extends ContractFetchInit, R>(inner: ContractFetch<I, R>): ContractFetch<I, R | Response>;
}

/** One request as the suite's transport saw it. */
export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /** The `redirect` option as given; `undefined` means `fetch`'s default, `follow`. */
  readonly redirect: string | undefined;
  /** Where the credential (or a transformed form of it) appeared. */
  readonly credentialIn: ReadonlyArray<"url" | "headers" | "body">;
}

export interface ContractFixture {
  /** A fresh adapter whose next provider request gets the scenario. */
  readonly adapter: ProviderAdapter;
  /** A model the connection offers, supporting streaming, system prompts and tool use. */
  readonly model: string;
  /** Provider requests made by `generate` and `stream` so far. */
  requestCount(): number;
  /** Responses still open on the wire. Required: release checks never skip (S9). */
  openStreams(): number;
  /**
   * The last request as the adapter put it on the wire, mapped back to these
   * fields (for an HTTP adapter: `model`, `max_tokens`, `system`,
   * `stop_sequences` from the body). Undefined before any request. The suite
   * checks that the adapter forwards them unchanged (NS1).
   */
  lastRequest(): ForwardedRequest | undefined;
}

/** The request fields an adapter must forward unchanged. */
export interface ForwardedRequest {
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly system?: string;
  readonly stopSequences?: readonly string[];
}

export interface ContractHarness {
  readonly name: string;
  /** A marker the simulated provider echoes into error bodies. It must never reach an error. */
  readonly canary: string;
  /**
   * The API credential the harness configures the adapter with (ANT-1). The
   * simulated provider echoes it into error bodies and headers; it must never
   * appear in an error, an event or a result, whole or as any 12-character
   * window (NS5). Use a low-entropy test value of at least 16 characters that
   * shares no 12-character run with the suite's own strings.
   */
  readonly credential: string;
  /**
   * Every scenario must be simulated; a missing one fails the suite rather
   * than skipping. An adapter with a network origin must be built with
   * `transport.wrap(inner)` as its `fetch`, in every scenario.
   */
  setup(scenario: ContractScenario, transport: ContractTransport): ContractFixture | Promise<ContractFixture>;
  /**
   * Required, with a reason, when the adapter has no network origin (the
   * mock): it makes no request, so the transport must record none. Must be
   * absent for an adapter with an origin.
   */
  readonly noNetwork?: string;
  /** A model id the connection does not offer. */
  readonly unknownModel?: string;
  /** How long a cancelled call may take to settle. Default 2000 ms. */
  readonly cancelWithinMs?: number;
}
