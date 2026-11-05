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

type AbortWhy = "cancelled" | "timeout_idle" | "timeout_request";

function abortError(why: AbortWhy): ProviderError {
  if (why === "cancelled") return new ProviderError("cancelled");
  return new ProviderError("timeout", { reason: why === "timeout_idle" ? "idle" : "request" });
}

/** One request's abort plumbing: the caller's signal plus our timeouts. */
class RequestControl {
  readonly controller = new AbortController();
  why: AbortWhy | undefined;
  /** Rejecters of the calls `race` is waiting on; each is removed as soon as its call settles. */
  private readonly pending = new Set<(e: unknown) => void>();
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
    for (const reject of [...this.pending]) reject(abortError(why));
    this.pending.clear();
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // A listener failure must not stop the abort.
      }
    }
  }

  /**
   * Settle with `p`, or fail as soon as the request is aborted, whichever is
   * first. Not `Promise.race` against one abort promise that lives as long as
   * the stream: every race would add a reaction to it, keeping each settled
   * step alive until the stream ends (about 430 bytes per event; review of
   * guard.ts:228). Each call registers its own rejecter and removes it when
   * `p` settles, so nothing accumulates.
   */
  race<T>(p: Promise<T>): Promise<T> {
    const why = this.why;
    if (why !== undefined) {
      p.catch(() => undefined);
      return Promise.reject(abortError(why));
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.add(reject);
      p.then(
        (v) => {
          this.pending.delete(reject);
          resolve(v);
        },
        (e: unknown) => {
          this.pending.delete(reject);
          reject(e);
        },
      );
    });
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

/**
 * Budget hooks whose `recordUsage` failed. The guard refuses every later
 * request on them (`budget_exceeded`/`state_invalid`): spend that could not
 * be recorded must not be followed by more (S4, NN3).
 */
const failedBudgets = new WeakSet<object>();

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

/** Fixed overheads, in tokens, for the request envelope, each message, and tool use (the provider's tool prompt). */
const REQUEST_OVERHEAD_TOKENS = 64;
const MESSAGE_OVERHEAD_TOKENS = 8;
const TOOL_USE_OVERHEAD_TOKENS = 512;
const PER_TOOL_OVERHEAD_TOKENS = 64;

/** ASCII characters and other code points in a string. */
function charClasses(s: string, acc: { ascii: number; other: number }): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) acc.ascii += 1;
    else {
      acc.other += 1;
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) i += 1; // one code point for a surrogate pair
    }
  }
}

/**
 * A high input estimate, used for budget reservations (NN4). It is an
 * estimate, not a bound: ASCII text at two characters per token; every other
 * code point (CJK, emoji, accents) at two tokens; a fixed charge per request,
 * per message and for tool use (the provider's tool prompt) and per tool; and
 * a flat 2,000 per image, above the roughly 1,600 that providers charge for
 * the largest image they accept without resizing. A provider can still
 * report more; the run budget's overshoot is bounded by that difference.
 */
export function estimateInputTokens(r: ValidRequest): number {
  const acc = { ascii: 0, other: 0 };
  let images = 0;
  if (r.system !== undefined) charClasses(r.system, acc);
  for (const m of r.messages) {
    for (const b of m.content) {
      if (b.type === "text") charClasses(b.text, acc);
      else if (b.type === "image") images += 1;
      else if (b.type === "tool_use") {
        charClasses(JSON.stringify(b.input), acc);
        charClasses(b.name, acc);
      } else if (typeof b.content === "string") charClasses(b.content, acc);
      else for (const t of b.content) charClasses(t.text, acc);
    }
  }
  const tools = r.tools ?? [];
  for (const t of tools) {
    charClasses(t.name, acc);
    charClasses(t.description, acc);
    charClasses(JSON.stringify(t.inputSchema), acc);
  }
  const toolOverhead = tools.length > 0 ? TOOL_USE_OVERHEAD_TOKENS + tools.length * PER_TOOL_OVERHEAD_TOKENS : 0;
  return (
    REQUEST_OVERHEAD_TOKENS +
    r.messages.length * MESSAGE_OVERHEAD_TOKENS +
    Math.ceil(acc.ascii / 2) +
    acc.other * 2 +
    images * IMAGE_TOKEN_ESTIMATE +
    toolOverhead
  );
}

function requestChars(r: ValidRequest): number {
  let n = r.system?.length ?? 0;
  for (const m of r.messages) for (const b of m.content) if (b.type === "text") n += b.text.length;
  return n;
}

/** The adapter descriptor, checked once by `guardProvider` (R1). */
const descriptorSchema = z.object({
  apiVersion: z.literal(PROVIDER_ADAPTER_API_VERSION),
  providerId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  displayName: z.string().min(1).max(128),
  connectionId: z.string().min(1).max(256),
  destination: z.object({
    origin: z
      .string()
      .max(256)
      .refine((o) => {
        try {
          const u = new URL(o);
          return u.protocol === "https:" && u.origin === o;
        } catch {
          return false;
        }
      }, "an https origin")
      .optional(),
    description: z.string().min(1).max(512),
  }),
});

const listedModelsSchema = z
  .array(z.object({ id: modelIdSchema, displayName: z.string().max(256).optional() }))
  .max(MAX_LISTED_MODELS);

const tokenCountSchema = z.object({ inputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });

export function guardProvider(adapter: ProviderAdapter, options: GuardOptions): GuardedProvider {
  const raw = adapter.descriptor;
  if (raw?.apiVersion !== PROVIDER_ADAPTER_API_VERSION) {
    throw new RangeError(`adapter API version ${String(raw?.apiVersion)} is not supported`);
  }
  // Parsed and frozen once: the adapter cannot change it later, and a
  // malformed one is refused up front (R1).
  const parsedDescriptor = descriptorSchema.safeParse(raw);
  if (!parsedDescriptor.success) throw new TypeError("the adapter descriptor is malformed");
  const pd = parsedDescriptor.data;
  const d: AdapterDescriptor = Object.freeze({
    apiVersion: pd.apiVersion,
    providerId: pd.providerId,
    displayName: pd.displayName,
    connectionId: pd.connectionId,
    destination: Object.freeze(
      pd.destination.origin === undefined
        ? { description: pd.destination.description }
        : { origin: pd.destination.origin, description: pd.destination.description },
    ),
  });
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
    // Every path, the public getCapabilities included, checks and scans the
    // model id before the adapter sees it (R5).
    if (!modelIdSchema.safeParse(model).success) {
      throw new ProviderError("invalid_request", { message: 'The request field "model" is invalid.', reason: "schema" });
    }
    if (redactor.containsSecret(model)) throw new ProviderError("secret_in_request");
    const raw = await call(signal, (o) => adapter.getCapabilities(model, o));
    const parsed = modelCapabilitiesSchema.safeParse(raw);
    if (!parsed.success || parsed.data.modelId !== model) throw new ProviderError("invalid_response", { reason: "malformed_capabilities" });
    return parsed.data;
  };

  /** Common log fields. Descriptor fields are adapter data and are redacted on every line (R1). */
  const base = (runId: string, model: string, mode: GuardMode) => ({
    runId,
    providerId: redactor.redact(d.providerId),
    connectionId: redactor.redact(d.connectionId),
    destination: redactor.redact(d.destination.origin ?? d.destination.description),
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

  /**
   * What to reserve for a request: the input priced at the higher of the plain
   * input rate and the cache-write rate (a request may write the prompt cache,
   * which providers bill at a premium), plus the output (R6). Undefined if
   * either price is unknown.
   */
  const reserveCost = (model: string, inputTokens: number, outputTokens: number): CostEstimate | undefined => {
    const plain = safeCost(model, { inputTokens, outputTokens });
    const cached = safeCost(model, { inputTokens: 0, outputTokens, cacheWriteTokens: inputTokens });
    if (plain === undefined || cached === undefined) return undefined;
    return plain.microUsd >= cached.microUsd ? plain : cached;
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
      const budget = args[0].budget;
      if (budget !== undefined) failedBudgets.add(budget);
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
        if (failedBudgets.has(run.budget)) throw new ProviderError("budget_exceeded", { reason: "state_invalid" });
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
          worstCaseCost: reserveCost(valid.model, estimatedInputTokens, valid.maxOutputTokens),
          costForOutput: (outputTokens: number) => reserveCost(valid.model, estimatedInputTokens, outputTokens)?.microUsd,
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
      let overCap: Usage | undefined;
      try {
        if (ctl.why !== undefined) throw abortError(ctl.why); // N1: never call the adapter with an aborted signal.
        sent = true;
        const raw = await ctl.race(Promise.resolve().then(() => adapter.generate(valid, { signal: ctl.controller.signal })));
        const checked = checkResult(raw, streamLimits);
        if (checked.usage.outputTokens > valid.maxOutputTokens) {
          overCap = checked.usage;
          throw new ProviderError("invalid_response", { reason: "output_over_cap" });
        }
        result = checked;
      } catch (e) {
        error = fromAdapter(e, ctl.why);
      } finally {
        ctl.dispose();
      }
      const [usage, charged] =
        overCap !== undefined ? [overCap, "reported" as const] : charge(prep, result?.usage, result !== undefined, false, error, sent);
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
        // The provider must stop at the output cap the guard set (NS1); its
        // reported usage is still charged.
        if ((ev.type === "usage" || ev.type === "message_stop") && ev.usage.outputTokens > valid.maxOutputTokens) {
          throw new ProviderError("invalid_response", { reason: "output_over_cap" });
        }
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
