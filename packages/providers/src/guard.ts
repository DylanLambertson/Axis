// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import type { BudgetHook } from "./budget.js";
import { ProviderError, sanitizeProviderError, type ProviderErrorCode } from "./errors.js";
import { stringsIn, type Redactor } from "./redaction.js";
import { StreamValidator, type StreamLimits } from "./stream.js";
import {
  PROVIDER_ADAPTER_API_VERSION,
  ZERO_USAGE,
  modelCapabilitiesSchema,
  modelIdSchema,
  type AdapterDescriptor,
  type CallOptions,
  type ConnectionCheck,
  type CostEstimate,
  type GenerateRequest,
  type GenerateResult,
  type ModelCapabilities,
  type ModelInfo,
  type ProviderAdapter,
  type StreamEvent,
  type TokenCount,
  type Usage,
} from "./types.js";
import { checkCapabilities, validateRequest, type ValidRequest } from "./validate.js";

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

/** Tokens charged for an inline image when estimating input (base64 length says little about tokens). */
const IMAGE_TOKEN_ESTIMATE = 2_000;
/** Usage used to ask an adapter whether it can price a model at all, cache counters included (B2). */
const PROBE_USAGE: Usage = { inputTokens: 1_000, outputTokens: 1_000, cacheReadTokens: 1_000, cacheWriteTokens: 1_000 };

/**
 * Errors that are pre-generation by definition: the provider refused the
 * request before producing anything, so nothing is charged (S5, NS3).
 */
const NOT_BILLED: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  "invalid_request",
  "authentication",
  "permission_denied",
  "not_found",
  "rate_limited",
  "context_length_exceeded",
  "unsupported_capability",
]);

/**
 * Errors after which the provider may already have read the prompt (and, for
 * `generate`, generated): charged the input estimate when no output was seen,
 * in both paths (NS3). Anything else is charged input plus the output cap.
 */
const INPUT_BILLED: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>(["server_error", "overloaded"]);

/**
 * Codes only the guard may raise. An adapter that throws one (or `cancelled`
 * when nothing was cancelled) is misreporting, and gets `internal` (NS3).
 * `timeout` stays: adapters keep their own wire timeouts (ANT-1).
 */
const GUARD_ONLY: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>(["budget_exceeded", "secret_in_request", "cancelled"]);

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

type AbortWhy = "cancelled" | "timeout_idle" | "timeout_request";

function abortError(why: AbortWhy): ProviderError {
  if (why === "cancelled") return new ProviderError("cancelled");
  return new ProviderError("timeout", { reason: why === "timeout_idle" ? "idle" : "request" });
}

/** One request's abort plumbing: the caller's signal plus our timeouts. */
class RequestControl {
  readonly controller = new AbortController();
  why: AbortWhy | undefined;
  private readonly aborted: Promise<never>;
  private rejectAborted: ((e: unknown) => void) | undefined;
  private idleHandle: unknown;
  private readonly requestHandle: unknown;
  private readonly listeners: Array<() => void> = [];
  private readonly onCallerAbort = (): void => this.abort("cancelled");

  constructor(
    private readonly callerSignal: AbortSignal,
    private readonly timers: Timers,
    private readonly idleMs: number,
    requestMs: number,
  ) {
    this.aborted = new Promise<never>((_, reject) => {
      this.rejectAborted = reject;
    });
    this.aborted.catch(() => undefined);
    callerSignal.addEventListener("abort", this.onCallerAbort, { once: true });
    this.requestHandle = timers.setTimeout(() => this.abort("timeout_request"), requestMs);
    if (callerSignal.aborted) this.abort("cancelled");
  }

  /** Start (or restart) the idle timer: we are now waiting on the provider. */
  touch(): void {
    this.pause();
    if (this.why === undefined) this.idleHandle = this.timers.setTimeout(() => this.abort("timeout_idle"), this.idleMs);
  }

  /** Stop the idle timer: the consumer, not the provider, has the turn (S2). */
  pause(): void {
    if (this.idleHandle !== undefined) this.timers.clearTimeout(this.idleHandle);
    this.idleHandle = undefined;
  }

  onAbort(fn: () => void): void {
    this.listeners.push(fn);
  }

  abort(why: AbortWhy): void {
    if (this.why !== undefined) return;
    this.why = why;
    this.controller.abort();
    this.rejectAborted?.(abortError(why));
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // A listener failure must not stop the abort.
      }
    }
  }

  /** Settle with `p`, or fail as soon as the request is aborted, whichever is first. */
  race<T>(p: Promise<T>): Promise<T> {
    return Promise.race([p, this.aborted]);
  }

  dispose(): void {
    this.callerSignal.removeEventListener("abort", this.onCallerAbort);
    this.timers.clearTimeout(this.requestHandle);
    this.pause();
  }
}

/** A limit: `undefined` means the default; anything else must be a positive safe integer at most `max` (S7). */
function limitOf(name: string, value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`guard limit ${name} must be an integer from 1 to ${max}`);
  }
  return value;
}

let requestSeq = 0;
function nextRequestSeq(): number {
  requestSeq += 1;
  return requestSeq;
}

function read(o: object, key: string): unknown {
  try {
    return (o as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** A deliberately high input estimate: two characters per token, images at a fixed charge. */
export function estimateInputTokens(r: ValidRequest): number {
  let chars = r.system?.length ?? 0;
  let images = 0;
  for (const m of r.messages) {
    for (const b of m.content) {
      if (b.type === "text") chars += b.text.length;
      else if (b.type === "image") images += 1;
      else if (b.type === "tool_use") chars += JSON.stringify(b.input).length + b.name.length;
      else chars += typeof b.content === "string" ? b.content.length : b.content.reduce((n, t) => n + t.text.length, 0);
    }
  }
  for (const t of r.tools ?? []) chars += t.name.length + t.description.length + JSON.stringify(t.inputSchema).length;
  return Math.ceil(chars / 2) + images * IMAGE_TOKEN_ESTIMATE;
}

function requestChars(r: ValidRequest): number {
  let n = r.system?.length ?? 0;
  for (const m of r.messages) for (const b of m.content) if (b.type === "text") n += b.text.length;
  return n;
}

const listedModelsSchema = z
  .array(z.object({ id: modelIdSchema, displayName: z.string().max(256).optional() }))
  .max(MAX_LISTED_MODELS);

const tokenCountSchema = z.object({ inputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });

export function guardProvider(adapter: ProviderAdapter, options: GuardOptions): GuardedProvider {
  const d = adapter.descriptor;
  if (d.apiVersion !== PROVIDER_ADAPTER_API_VERSION) {
    throw new RangeError(`adapter API version ${String(d.apiVersion)} is not supported`);
  }
  const redactor = options.redactor;
  if (typeof redactor?.redact !== "function" || typeof redactor.containsSecret !== "function") {
    throw new TypeError("guardProvider needs a redactor (pass NO_SECRETS explicitly for a connection without credentials)");
  }
  const timers: Timers = options.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const now = options.now ?? (() => Date.now());
  const idleMs = limitOf("idleTimeoutMs", options.limits?.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const requestMs = limitOf("requestTimeoutMs", options.limits?.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const streamLimits: StreamLimits = {
    ...(options.limits?.maxEvents === undefined ? {} : { maxEvents: options.limits.maxEvents }),
    ...(options.limits?.maxTextChars === undefined ? {} : { maxTextChars: options.limits.maxTextChars }),
    ...(options.limits?.maxToolInputChars === undefined ? {} : { maxToolInputChars: options.limits.maxToolInputChars }),
    ...(options.limits?.maxResponseChars === undefined ? {} : { maxResponseChars: options.limits.maxResponseChars }),
  };
  new StreamValidator(streamLimits); // Validates the limits now rather than at the first request.

  const log = (r: ProviderLogRecord): void => {
    try {
      options.log?.(r);
    } catch {
      // A failing log sink must not change the outcome of a request.
    }
  };

  const normalize = (e: unknown, why: AbortWhy | undefined): ProviderError =>
    why === undefined ? sanitizeProviderError(e, redactor) : abortError(why);

  /** `normalize` for anything that came out of an adapter call. Total: never throws (NS4). */
  const fromAdapter = (e: unknown, why: AbortWhy | undefined): ProviderError => {
    const err = normalize(e, why);
    return why === undefined && GUARD_ONLY.has(err.code) ? new ProviderError("internal") : err;
  };

  /** A non-run call (list, capabilities, validate, count): timeouts, abort race, rebuilt errors. */
  const call = async <T>(signal: AbortSignal, fn: (opts: CallOptions) => Promise<T>): Promise<T> => {
    const ctl = new RequestControl(signal, timers, requestMs, requestMs);
    try {
      if (ctl.why !== undefined) throw abortError(ctl.why);
      return await ctl.race(Promise.resolve().then(() => fn({ signal: ctl.controller.signal })));
    } catch (e) {
      throw fromAdapter(e, ctl.why);
    } finally {
      ctl.dispose();
    }
  };

  /** Capabilities as a fresh, schema-checked object for exactly the model asked (N5). */
  const capabilities = async (model: string, signal: AbortSignal): Promise<ModelCapabilities> => {
    const raw = await call(signal, (o) => adapter.getCapabilities(model, o));
    const parsed = modelCapabilitiesSchema.safeParse(raw);
    if (!parsed.success || parsed.data.modelId !== model) throw new ProviderError("invalid_response", { reason: "malformed_capabilities" });
    return parsed.data;
  };

  const base = (runId: string, model: string, mode: GuardMode) => ({
    runId,
    providerId: d.providerId,
    connectionId: d.connectionId,
    destination: d.destination.origin ?? d.destination.description,
    model,
    mode,
  });

  /** A validated cost, or undefined: NaN, negative, non-object or throwing estimates count as unpriced (B2). */
  const safeCost = (model: string, usage: Usage): CostEstimate | undefined => {
    if (adapter.estimateCost === undefined) return undefined;
    let c: unknown;
    try {
      c = adapter.estimateCost(model, usage);
    } catch {
      return undefined;
    }
    if (typeof c !== "object" || c === null) return undefined;
    const micro = read(c, "microUsd");
    if (typeof micro !== "number" || !Number.isFinite(micro) || micro < 0) return undefined;
    const rounded = Math.ceil(micro);
    return Number.isSafeInteger(rounded) ? { microUsd: rounded } : undefined;
  };

  /**
   * The checks every outgoing request passes, in an order that sends and logs
   * nothing unchecked:
   * 1. the model id;
   * 2. a synchronous parse of the request, which is the snapshot that will be
   *    sent: zod builds fresh objects and arrays and clones JSON values, so
   *    later changes to the caller's object (or a Proxy that answers
   *    differently to different reads) cannot reach the adapter (NB1);
   * 3. the secret scan over that snapshot, before any `await`;
   * 4. capabilities (the first adapter call), checked against the snapshot.
   * Validation messages never echo values or record keys (S1).
   */
  const preflight = async (
    request: GenerateRequest,
    signal: AbortSignal,
    mode: GuardMode,
    setModel: (m: string) => void,
  ): Promise<ValidRequest> => {
    if (signal.aborted) throw new ProviderError("cancelled");
    const model = modelIdSchema.safeParse(read(request, "model"));
    if (!model.success) throw new ProviderError("invalid_request", { message: 'The request field "model" is invalid.', reason: "schema" });
    const valid = validateRequest(request);
    const scanner = redactor.snapshot?.() ?? redactor;
    for (const s of stringsIn(valid)) {
      if (scanner.containsSecret(s)) throw new ProviderError("secret_in_request");
    }
    setModel(valid.model);
    const caps = await capabilities(valid.model, signal);
    checkCapabilities(valid, caps, mode === "stream" ? "stream" : "generate");
    if (mode === "count_tokens" && caps.features.tokenCounting !== "supported") {
      throw new ProviderError("unsupported_capability", { capability: "tokenCounting" });
    }
    return valid;
  };

  interface Prepared {
    readonly request: ValidRequest;
    readonly requestId: string | undefined;
    readonly estimatedInputTokens: number;
  }

  const outcomeOf = (err: ProviderError): "failed" | "cancelled" => (err.code === "cancelled" ? "cancelled" : "failed");

  const record = async (
    run: RunOptions,
    requestId: string | undefined,
    model: string,
    usage: Usage,
    charged: "reported" | "estimated" | "none",
    outcome: "completed" | "failed" | "cancelled",
  ): Promise<void> => {
    if (run.budget === undefined || requestId === undefined) return;
    await run.budget.recordUsage({
      requestId,
      runId: run.runId,
      providerId: d.providerId,
      connectionId: d.connectionId,
      model,
      usage,
      charged,
      cost: charged === "none" ? undefined : safeCost(model, usage),
      outcome,
    });
  };

  /** Record once; a budget that cannot record becomes an `internal` error, never a raw one (S4). */
  const recordSafely = async (...args: Parameters<typeof record>): Promise<ProviderError | undefined> => {
    try {
      await record(...args);
      return undefined;
    } catch {
      return new ProviderError("internal", { reason: "budget_record_failed" });
    }
  };

  /** Pre-flight plus the budget. Throws a ProviderError; nothing has been sent if it does. */
  const prepare = async (request: GenerateRequest, run: RunOptions, mode: "generate" | "stream"): Promise<Prepared> => {
    let model = "";
    let reservation: string | undefined;
    try {
      const valid = await preflight(request, run.signal, mode, (m) => (model = m));
      const estimatedInputTokens = estimateInputTokens(valid);
      if (run.budget !== undefined) {
        const requestId = `${run.runId}#${nextRequestSeq()}`;
        const decision = await run.budget.beforeRequest({
          requestId,
          runId: run.runId,
          providerId: d.providerId,
          connectionId: d.connectionId,
          model: valid.model,
          maxOutputTokens: valid.maxOutputTokens,
          estimatedInputTokens,
          costKnown: safeCost(valid.model, PROBE_USAGE) !== undefined,
          worstCaseCost: safeCost(valid.model, { inputTokens: estimatedInputTokens, outputTokens: valid.maxOutputTokens }),
        });
        if (decision.allow !== true) {
          const reason = read(decision, "reason");
          throw new ProviderError("budget_exceeded", { reason: typeof reason === "string" ? reason : "denied" });
        }
        reservation = requestId;
        if (decision.maxOutputTokens !== undefined) {
          if (!Number.isSafeInteger(decision.maxOutputTokens) || decision.maxOutputTokens < 1) {
            throw new ProviderError("budget_exceeded", { reason: "tokens" });
          }
          valid.maxOutputTokens = Math.min(valid.maxOutputTokens, decision.maxOutputTokens);
        }
      }
      if (run.signal.aborted) throw new ProviderError("cancelled");
      return { request: valid, requestId: reservation, estimatedInputTokens };
    } catch (e) {
      const err = normalize(e, run.signal.aborted ? "cancelled" : undefined);
      // Allowed, then refused before sending: settle the reservation with zero usage (N7).
      if (reservation !== undefined) await recordSafely(run, reservation, model, ZERO_USAGE, "none", outcomeOf(err));
      log({
        ...base(run.runId, model, mode),
        event: "request_refused",
        errorCode: err.code,
        message: err.message,
        ...(err.details.reason === undefined ? {} : { reason: err.details.reason }),
      });
      throw err;
    }
  };

  /**
   * What to charge for a request (S5, NS3, NN7):
   * - completed: the reported usage;
   * - never sent to the adapter: nothing;
   * - refused before any output with a pre-generation code: nothing;
   * - `server_error` or `overloaded` before any output: the input;
   * - anything else: the last reported input (or the estimate) plus the
   *   full output cap, or the reported output if it is higher.
   */
  const charge = (
    prep: Prepared,
    reported: Usage | undefined,
    complete: boolean,
    sawEvent: boolean,
    error: ProviderError | undefined,
    sent: boolean,
  ): [Usage, "reported" | "estimated" | "none"] => {
    if (complete && reported !== undefined) return [reported, "reported"];
    if (!sent) return [ZERO_USAGE, "none"];
    const input = reported?.inputTokens ?? prep.estimatedInputTokens;
    if (error !== undefined && !sawEvent) {
      if (NOT_BILLED.has(error.code)) return [ZERO_USAGE, "none"];
      if (INPUT_BILLED.has(error.code)) return [{ inputTokens: input, outputTokens: 0 }, "estimated"];
    }
    const u: { -readonly [K in keyof Usage]: Usage[K] } = {
      inputTokens: input,
      outputTokens: Math.max(reported?.outputTokens ?? 0, prep.request.maxOutputTokens),
    };
    if (reported?.cacheReadTokens !== undefined) u.cacheReadTokens = reported.cacheReadTokens;
    if (reported?.cacheWriteTokens !== undefined) u.cacheWriteTokens = reported.cacheWriteTokens;
    return [u, "estimated"];
  };

  return {
    descriptor: d,

    async listModels(opts) {
      const raw = await call(opts.signal, (o) => adapter.listModels(o));
      const parsed = listedModelsSchema.safeParse(raw);
      if (!parsed.success) throw new ProviderError("invalid_response", { reason: "malformed_models" });
      return parsed.data.map((m) => (m.displayName === undefined ? { id: m.id } : { id: m.id, displayName: m.displayName }));
    },

    getCapabilities: (model, opts) => capabilities(model, opts.signal),

    async validateConnection(opts) {
      const r: unknown = await call(opts.signal, (o) => adapter.validateConnection(o));
      if (typeof r === "object" && r !== null && read(r, "ok") === true) return { ok: true };
      const error = typeof r === "object" && r !== null ? read(r, "error") : undefined;
      return { ok: false, error: fromAdapter(error, undefined) };
    },

    async countTokens(request, run) {
      let model = "";
      let valid: ValidRequest;
      try {
        if (adapter.countTokens === undefined) throw new ProviderError("unsupported_capability", { capability: "tokenCounting" });
        valid = await preflight(request, run.signal, "count_tokens", (m) => (model = m));
      } catch (e) {
        const err = normalize(e, run.signal.aborted ? "cancelled" : undefined);
        log({ ...base(run.runId, model, "count_tokens"), event: "request_refused", errorCode: err.code, message: err.message, ...(err.details.reason === undefined ? {} : { reason: err.details.reason }) });
        throw err;
      }
      const started = now();
      log({ ...base(run.runId, valid.model, "count_tokens"), event: "request_start", messageCount: valid.messages.length, requestChars: requestChars(valid) });
      try {
        const raw = await call(run.signal, (o) => (adapter.countTokens as NonNullable<ProviderAdapter["countTokens"]>)(valid, o));
        const parsed = tokenCountSchema.safeParse(raw);
        if (!parsed.success) throw new ProviderError("invalid_response", { reason: "malformed_token_count" });
        log({ ...base(run.runId, valid.model, "count_tokens"), event: "request_end", outcome: "completed", durationMs: now() - started });
        return { inputTokens: parsed.data.inputTokens };
      } catch (e) {
        const err = normalize(e, undefined);
        log({ ...base(run.runId, valid.model, "count_tokens"), event: "request_end", outcome: outcomeOf(err), errorCode: err.code, message: err.message, durationMs: now() - started });
        throw err;
      }
    },

    async generate(request, run) {
      const prep = await prepare(request, run, "generate");
      const valid = prep.request;
      const started = now();
      log({ ...base(run.runId, valid.model, "generate"), event: "request_start", messageCount: valid.messages.length, requestChars: requestChars(valid) });
      // A non-streaming answer has no events, so only the request timeout
      // applies: an idle timer would cut off a long generation (NN8).
      const ctl = new RequestControl(run.signal, timers, requestMs, requestMs);
      let result: GenerateResult | undefined;
      let error: ProviderError | undefined;
      let sent = false;
      try {
        if (ctl.why !== undefined) throw abortError(ctl.why); // N1: never call the adapter with an aborted signal.
        sent = true;
        const raw = await ctl.race(Promise.resolve().then(() => adapter.generate(valid, { signal: ctl.controller.signal })));
        result = checkResult(raw, streamLimits);
      } catch (e) {
        error = fromAdapter(e, ctl.why);
      } finally {
        ctl.dispose();
      }
      const [usage, charged] = charge(prep, result?.usage, result !== undefined, false, error, sent);
      const outcome = error === undefined ? "completed" : outcomeOf(error);
      error = (await recordSafely(run, prep.requestId, valid.model, usage, charged, outcome)) ?? error;
      log({
        ...base(run.runId, valid.model, "generate"),
        event: "request_end",
        outcome: error === undefined ? "completed" : outcomeOf(error),
        ...(error === undefined ? {} : { errorCode: error.code, message: error.message }),
        usage,
        charged,
        durationMs: now() - started,
      });
      if (error !== undefined || result === undefined) throw error ?? new ProviderError("internal");
      return result;
    },

    stream(request, run) {
      return {
        [Symbol.asyncIterator]: () => guardedStream(request, run),
      };
    },
  };

  async function* guardedStream(request: GenerateRequest, run: RunOptions): AsyncGenerator<StreamEvent, void, undefined> {
    const prep = await prepare(request, run, "stream");
    const valid = prep.request;
    const started = now();
    log({ ...base(run.runId, valid.model, "stream"), event: "request_start", messageCount: valid.messages.length, requestChars: requestChars(valid) });
    const ctl = new RequestControl(run.signal, timers, idleMs, requestMs);
    const validator = new StreamValidator(streamLimits);
    let iterator: AsyncIterator<StreamEvent> | undefined;
    let suspended = false;
    let sawEvent = false;
    let sent = false;
    let finalized: Promise<ProviderError | undefined> | undefined;

    /** Release, record and log exactly once, however the stream ends (S3, S4, S5). */
    const finalize = (error: ProviderError | undefined): Promise<ProviderError | undefined> => {
      finalized ??= (async () => {
        // Always abort the adapter's signal unless the stream completed; call
        // `return()` only if the iterator has one, and never wait on it.
        if (!validator.complete || error !== undefined) ctl.controller.abort();
        const it = iterator;
        if (it?.return !== undefined) {
          void Promise.resolve()
            .then(() => it.return?.())
            .catch(() => undefined);
        }
        ctl.dispose();
        const complete = validator.complete && error === undefined;
        const outcome = error === undefined ? (complete ? "completed" : "cancelled") : outcomeOf(error);
        const [usage, charged] = charge(prep, validator.usage, validator.complete, sawEvent, error, sent);
        const out = (await recordSafely(run, prep.requestId, valid.model, usage, charged, outcome)) ?? error;
        log({
          ...base(run.runId, valid.model, "stream"),
          event: "request_end",
          outcome: out === undefined ? outcome : outcomeOf(out),
          ...(out === undefined ? {} : { errorCode: out.code, message: out.message }),
          usage,
          charged,
          durationMs: now() - started,
        });
        return out;
      })();
      return finalized;
    };

    // Aborted while the consumer holds an event (cancel, or the request timeout
    // reaping an abandoned iterator): finish now rather than at the next `next()`.
    ctl.onAbort(() => {
      if (suspended && ctl.why !== undefined) void finalize(abortError(ctl.why));
    });

    let error: ProviderError | undefined;
    try {
      if (ctl.why !== undefined) throw abortError(ctl.why); // N1
      sent = true;
      iterator = adapter.stream(valid, { signal: ctl.controller.signal })[Symbol.asyncIterator]();
      for (;;) {
        ctl.touch();
        const step = await ctl.race(iterator.next());
        ctl.pause();
        if (step.done === true) break;
        const ev = validator.accept(step.value);
        sawEvent = true;
        suspended = true;
        try {
          yield ev;
        } finally {
          suspended = false;
        }
        if (ctl.why !== undefined) throw abortError(ctl.why);
      }
      validator.result();
    } catch (e) {
      error = fromAdapter(e, ctl.why);
    } finally {
      // Runs on completion, on error and when the consumer stops early.
      error = await finalize(error);
    }
    if (error !== undefined) throw error;
  }
}

/** Run a `generate` result through the stream grammar, so both paths are held to the same rules. */
function checkResult(raw: unknown, limits: StreamLimits): GenerateResult {
  const bad = (): ProviderError => new ProviderError("invalid_response", { reason: "malformed_result" });
  if (typeof raw !== "object" || raw === null) throw bad();
  const content = read(raw, "content");
  if (!Array.isArray(content)) throw bad();
  const id = read(raw, "id");
  const v = new StreamValidator(limits);
  v.accept(id === undefined ? { type: "message_start", model: read(raw, "model") } : { type: "message_start", id, model: read(raw, "model") });
  content.forEach((b: unknown, index: number) => {
    if (typeof b !== "object" || b === null) throw bad();
    const type = read(b, "type");
    if (type === "text") {
      v.accept({ type: "content_block_start", index, block: { type: "text" } });
      v.accept({ type: "content_block_delta", index, delta: { type: "text", text: read(b, "text") } });
    } else if (type === "tool_use") {
      v.accept({ type: "content_block_start", index, block: { type: "tool_use", id: read(b, "id"), name: read(b, "name") } });
      const input = read(b, "input");
      // A tool call without input is malformed, not `{}` (N6).
      if (input === undefined) throw new ProviderError("invalid_response", { reason: "tool_input_missing" });
      let json: string | undefined;
      try {
        json = JSON.stringify(input);
      } catch {
        json = undefined;
      }
      if (json === undefined) throw new ProviderError("invalid_response", { reason: "tool_input_not_json" });
      v.accept({ type: "content_block_delta", index, delta: { type: "tool_input", partialJson: json } });
    } else {
      throw bad();
    }
    v.accept({ type: "content_block_stop", index });
  });
  v.accept({ type: "message_stop", stopReason: read(raw, "stopReason"), usage: read(raw, "usage") });
  return v.result();
}
