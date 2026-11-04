// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { BudgetHook } from "./budget.js";
import type { ProviderErrorCode } from "./errors.js";
import type { Redactor } from "./redaction.js";
import type { StreamLimits } from "./stream.js";
import type {
  AdapterDescriptor,
  CallOptions,
  ConnectionCheck,
  GenerateRequest,
  GenerateResult,
  ModelCapabilities,
  ModelInfo,
  StreamEvent,
  TokenCount,
  Usage,
} from "./types.js";

export interface GuardLimits extends StreamLimits {
  /** Longest wait for the next stream event. Consumer time does not count; `generate` uses only the request timeout (NN8). */
  readonly idleTimeoutMs?: number;
  /** Longest whole request, consumer time included; it also cleans up an abandoned stream. */
  readonly requestTimeoutMs?: number;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 900_000;
/** The largest delay `setTimeout` honours; larger values silently become 1 ms in Node (S7). */
export const MAX_TIMEOUT_MS = 2_147_483_647;
export const MAX_LISTED_MODELS = 1_000;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type GuardMode = "generate" | "stream" | "count_tokens";

/**
 * A metadata-only log record. Content (prompts, outputs, tool input) is never
 * logged; only counts and lengths (DMN-6). `message` is redacted; `model` is
 * logged only once it has been validated and scanned, otherwise it is "".
 */
export interface ProviderLogRecord {
  readonly event: "request_start" | "request_end" | "request_refused";
  readonly runId: string;
  readonly providerId: string;
  readonly connectionId: string;
  readonly destination: string;
  readonly model: string;
  readonly mode: GuardMode;
  readonly messageCount?: number;
  readonly requestChars?: number;
  readonly outcome?: "completed" | "failed" | "cancelled";
  readonly errorCode?: ProviderErrorCode;
  readonly reason?: string;
  readonly message?: string;
  readonly usage?: Usage;
  readonly charged?: "reported" | "estimated" | "none";
  readonly durationMs?: number;
}

export interface GuardOptions {
  /**
   * PRV-2 redaction hook. Required (S10): forgetting it would silently turn
   * off the outgoing secret scan and error redaction. Pass `NO_SECRETS`
   * explicitly for a connection that holds no credential.
   */
  readonly redactor: Redactor;
  readonly log?: (record: ProviderLogRecord) => void;
  readonly limits?: GuardLimits;
  readonly timers?: Timers;
  readonly now?: () => number;
}

export interface RunOptions {
  readonly runId: string;
  readonly signal: AbortSignal;
  /** PRV-6 per-run budget. Without one the run is unbudgeted. */
  readonly budget?: BudgetHook;
}

/**
 * The daemon-side wrapper every provider call goes through. It does not trust
 * the adapter to keep the contract:
 *
 * - Before any provider call: the model id is validated, the raw request is
 *   scanned for known secrets, the model's capabilities are fetched and
 *   checked, the request is validated, and the budget is asked. `countTokens`
 *   gets the same pre-flight minus the budget (B3).
 * - During: idle and request timeouts; cancellation is prompt even if the
 *   adapter ignores its signal; every event is checked against the grammar and
 *   limits; the adapter's signal is aborted whenever a stream ends early.
 * - After: usage is recorded exactly once per allowed request, conservatively
 *   when the provider never reported it; every error is rebuilt, redacted and
 *   bounded.
 *
 * Consumers of `stream` must finish iterating or call `return()` (a `break`
 * does). An abandoned iterator is cleaned up only when the request timeout
 * fires.
 *
 * If the budget cannot record a request's usage, that request fails with
 * `internal`/`budget_record_failed` in both paths: `generate` discards its
 * result, and a stream throws it after the last event, when the consumer
 * already has the output. Consumers must treat it as "stop the run", not
 * "discard the turn"; the guard refuses every later request on that budget
 * (S4, NN3).
 *
 * `countTokens` is not budgeted. A run stopped by its budget must not call it;
 * the daemon checks that before counting (NN6).
 */
export interface GuardedProvider {
  readonly descriptor: AdapterDescriptor;
  listModels(opts: CallOptions): Promise<readonly ModelInfo[]>;
  getCapabilities(model: string, opts: CallOptions): Promise<ModelCapabilities>;
  validateConnection(opts: CallOptions): Promise<ConnectionCheck>;
  countTokens(request: GenerateRequest, run: Omit<RunOptions, "budget">): Promise<TokenCount>;
  generate(request: GenerateRequest, run: RunOptions): Promise<GenerateResult>;
  stream(request: GenerateRequest, run: RunOptions): AsyncIterable<StreamEvent>;
}
