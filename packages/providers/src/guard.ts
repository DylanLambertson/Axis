// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { BudgetHook } from "./budget.js";
import { ProviderError, sanitizeProviderError, type ProviderErrorCode } from "./errors.js";
import { NO_SECRETS, stringsIn, type Redactor } from "./redaction.js";
import { StreamValidator, type StreamLimits } from "./stream.js";
import {
  PROVIDER_ADAPTER_API_VERSION,
  ZERO_USAGE,
  type AdapterDescriptor,
  type CallOptions,
  type ConnectionCheck,
  type GenerateRequest,
  type GenerateResult,
  type ModelCapabilities,
  type ModelInfo,
  type ProviderAdapter,
  type StreamEvent,
  type TokenCount,
  type Usage,
} from "./types.js";
import { validateRequest, type ValidRequest } from "./validate.js";

export interface GuardLimits extends StreamLimits {
  /** Longest gap between two stream events, or before `generate` returns. */
  readonly idleTimeoutMs?: number;
  /** Longest whole request. */
  readonly requestTimeoutMs?: number;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 900_000;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * A metadata-only log record. Content (prompts, outputs, tool input) is never
 * logged; only counts and lengths (DMN-6). `message` is redacted.
 */
export interface ProviderLogRecord {
  readonly event: "request_start" | "request_end" | "request_refused";
  readonly runId: string;
  readonly providerId: string;
  readonly connectionId: string;
  readonly destination: string;
  readonly model: string;
  readonly mode: "generate" | "stream";
  readonly messageCount?: number;
  readonly requestChars?: number;
  readonly outcome?: "completed" | "failed" | "cancelled";
  readonly errorCode?: ProviderErrorCode;
  readonly reason?: string;
  readonly message?: string;
  readonly usage?: Usage;
  readonly durationMs?: number;
}

export interface GuardOptions {
  /** PRV-2 redaction hook. Defaults to one that knows no secrets. */
  readonly redactor?: Redactor;
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
 * the adapter to keep the contract: it re-validates requests against the
 * model's capabilities, refuses a request that carries a known secret,
 * enforces the budget before each request, applies idle and request timeouts,
 * makes cancellation prompt even if the adapter ignores its signal, checks
 * every stream event against the grammar and limits, and replaces any error
 * message with a redacted, bounded one.
 */
export interface GuardedProvider {
  readonly descriptor: AdapterDescriptor;
  listModels(opts: CallOptions): Promise<readonly ModelInfo[]>;
  getCapabilities(model: string, opts: CallOptions): Promise<ModelCapabilities>;
  validateConnection(opts: CallOptions): Promise<ConnectionCheck>;
  countTokens(request: GenerateRequest, opts: CallOptions): Promise<TokenCount>;
  generate(request: GenerateRequest, run: RunOptions): Promise<GenerateResult>;
  stream(request: GenerateRequest, run: RunOptions): AsyncIterable<StreamEvent>;
}

type AbortWhy = "cancelled" | "timeout_idle" | "timeout_request";

/** One request's abort plumbing: the caller's signal plus our timeouts. */
class RequestControl {
  readonly controller = new AbortController();
  why: AbortWhy | undefined;
  private readonly aborted: Promise<never>;
  private rejectAborted: ((e: unknown) => void) | undefined;
  private idleHandle: unknown;
  private readonly requestHandle: unknown;
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
    this.touch();
    if (callerSignal.aborted) this.abort("cancelled");
  }

  /** Restart the idle timer (an event arrived). */
  touch(): void {
    if (this.idleHandle !== undefined) this.timers.clearTimeout(this.idleHandle);
    this.idleHandle = this.timers.setTimeout(() => this.abort("timeout_idle"), this.idleMs);
  }

  abort(why: AbortWhy): void {
    if (this.why !== undefined) return;
    this.why = why;
    this.controller.abort();
    this.rejectAborted?.(new ProviderError(why === "cancelled" ? "cancelled" : "timeout"));
  }

  /** Settle with `p`, or fail as soon as the request is aborted, whichever is first. */
  race<T>(p: Promise<T>): Promise<T> {
    return Promise.race([p, this.aborted]);
  }

  dispose(): void {
    this.callerSignal.removeEventListener("abort", this.onCallerAbort);
    this.timers.clearTimeout(this.requestHandle);
    if (this.idleHandle !== undefined) this.timers.clearTimeout(this.idleHandle);
  }
}

export function guardProvider(adapter: ProviderAdapter, options: GuardOptions = {}): GuardedProvider {
  const d = adapter.descriptor;
  if (d.apiVersion !== PROVIDER_ADAPTER_API_VERSION) {
    throw new RangeError(`adapter API version ${String(d.apiVersion)} is not supported`);
  }
  const redactor = options.redactor ?? NO_SECRETS;
  const timers: Timers = options.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const now = options.now ?? (() => Date.now());
  const idleMs = options.limits?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const requestMs = options.limits?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const streamLimits: StreamLimits = options.limits ?? {};
  const log = (r: ProviderLogRecord): void => {
    try {
      options.log?.(r);
    } catch {
      // A failing log sink must not change the outcome of a request.
    }
  };

  /** Any thrown value to a safe ProviderError. */
  const normalize = (e: unknown, why: AbortWhy | undefined): ProviderError => {
    if (why === "cancelled") return new ProviderError("cancelled");
    if (why === "timeout_idle") return new ProviderError("timeout", { reason: "idle" });
    if (why === "timeout_request") return new ProviderError("timeout", { reason: "request" });
    return sanitizeProviderError(e, redactor);
  };

  /** A non-run call (list, capabilities, validate, count): timeouts, abort race, normalized errors. */
  const call = async <T>(signal: AbortSignal, fn: (opts: CallOptions) => Promise<T>): Promise<T> => {
    const ctl = new RequestControl(signal, timers, requestMs, requestMs);
    try {
      if (ctl.why !== undefined) throw new ProviderError("cancelled");
      return await ctl.race(Promise.resolve().then(() => fn({ signal: ctl.controller.signal })));
    } catch (e) {
      throw normalize(e, ctl.why);
    } finally {
      ctl.dispose();
    }
  };

  const base = (run: RunOptions, model: string, mode: "generate" | "stream") => ({
    runId: run.runId,
    providerId: d.providerId,
    connectionId: d.connectionId,
    destination: d.destination.origin ?? d.destination.description,
    model,
    mode,
  });

  /**
   * Everything before the provider request: capabilities, validation, secret
   * scan, budget. Throws a ProviderError; nothing has been sent if it does.
   */
  const prepare = async (request: GenerateRequest, run: RunOptions, mode: "generate" | "stream"): Promise<ValidRequest> => {
    const model = typeof request.model === "string" ? request.model : "";
    try {
      if (run.signal.aborted) throw new ProviderError("cancelled");
      const caps = await call(run.signal, (o) => adapter.getCapabilities(model, o));
      const valid = validateRequest(request, caps, mode);
      for (const s of stringsIn(valid)) {
        if (redactor.containsSecret(s)) throw new ProviderError("secret_in_request");
      }
      if (run.budget !== undefined) {
        const costKnown = adapter.estimateCost?.(valid.model, ZERO_USAGE) !== undefined;
        const decision = await run.budget.beforeRequest({
          runId: run.runId,
          providerId: d.providerId,
          connectionId: d.connectionId,
          model: valid.model,
          maxOutputTokens: valid.maxOutputTokens,
          costKnown,
        });
        if (!decision.allow) throw new ProviderError("budget_exceeded", { reason: decision.reason });
        if (decision.maxOutputTokens !== undefined) {
          if (!Number.isSafeInteger(decision.maxOutputTokens) || decision.maxOutputTokens < 1) {
            throw new ProviderError("budget_exceeded", { reason: "tokens" });
          }
          valid.maxOutputTokens = Math.min(valid.maxOutputTokens, decision.maxOutputTokens);
        }
      }
      if (run.signal.aborted) throw new ProviderError("cancelled");
      return valid;
    } catch (e) {
      const err = normalize(e, run.signal.aborted ? "cancelled" : undefined);
      log({
        ...base(run, model, mode),
        event: "request_refused",
        errorCode: err.code,
        message: err.message,
        ...(err.details.reason === undefined ? {} : { reason: err.details.reason }),
      });
      throw err;
    }
  };

  const record = async (
    run: RunOptions,
    model: string,
    usage: Usage | undefined,
    outcome: "completed" | "failed" | "cancelled",
  ): Promise<void> => {
    if (run.budget === undefined) return;
    const u = usage ?? ZERO_USAGE;
    let cost: ReturnType<NonNullable<ProviderAdapter["estimateCost"]>>;
    try {
      cost = adapter.estimateCost?.(model, u);
    } catch {
      cost = undefined;
    }
    await run.budget.recordUsage({
      runId: run.runId,
      providerId: d.providerId,
      connectionId: d.connectionId,
      model,
      usage: u,
      cost,
      outcome,
    });
  };

  const requestChars = (r: ValidRequest): number => {
    let n = 0;
    for (const s of stringsIn(r)) n += s.length;
    return n;
  };

  const outcomeOf = (err: ProviderError): "failed" | "cancelled" => (err.code === "cancelled" ? "cancelled" : "failed");

  return {
    descriptor: d,
    listModels: (opts) => call(opts.signal, (o) => adapter.listModels(o)),
    getCapabilities: (model, opts) => call(opts.signal, (o) => adapter.getCapabilities(model, o)),
    validateConnection: (opts) =>
      call(opts.signal, (o) => adapter.validateConnection(o)).then(
        (r): ConnectionCheck => (r.ok === true ? { ok: true } : { ok: false, error: normalize(read(r, "error"), undefined) }),
      ),
    countTokens: (request, opts) =>
      call(opts.signal, async (o) => {
        if (adapter.countTokens === undefined) {
          throw new ProviderError("unsupported_capability", { capability: "tokenCounting" });
        }
        return adapter.countTokens(validateRequest(request), o);
      }),

    async generate(request, run) {
      const valid = await prepare(request, run, "generate");
      const started = now();
      log({ ...base(run, valid.model, "generate"), event: "request_start", messageCount: valid.messages.length, requestChars: requestChars(valid) });
      const ctl = new RequestControl(run.signal, timers, idleMs, requestMs);
      let usage: Usage | undefined;
      try {
        const raw = await ctl.race(Promise.resolve().then(() => adapter.generate(valid, { signal: ctl.controller.signal })));
        const result = checkResult(raw, streamLimits);
        usage = result.usage;
        await record(run, valid.model, usage, "completed");
        log({ ...base(run, valid.model, "generate"), event: "request_end", outcome: "completed", usage, durationMs: now() - started });
        return result;
      } catch (e) {
        const err = normalize(e, ctl.why);
        await record(run, valid.model, usage, outcomeOf(err));
        log({ ...base(run, valid.model, "generate"), event: "request_end", outcome: outcomeOf(err), errorCode: err.code, message: err.message, durationMs: now() - started });
        throw err;
      } finally {
        ctl.dispose();
      }
    },

    stream(request, run) {
      return {
        [Symbol.asyncIterator]: () => guardedStream(request, run),
      };
    },
  };

  async function* guardedStream(request: GenerateRequest, run: RunOptions): AsyncGenerator<StreamEvent, void, undefined> {
    const valid = await prepare(request, run, "stream");
    const started = now();
    log({ ...base(run, valid.model, "stream"), event: "request_start", messageCount: valid.messages.length, requestChars: requestChars(valid) });
    const ctl = new RequestControl(run.signal, timers, idleMs, requestMs);
    const validator = new StreamValidator(streamLimits);
    let iterator: AsyncIterator<StreamEvent> | undefined;
    let finished = false;
    let error: ProviderError | undefined;
    try {
      iterator = adapter.stream(valid, { signal: ctl.controller.signal })[Symbol.asyncIterator]();
      for (;;) {
        const step = await ctl.race(iterator.next());
        ctl.touch();
        if (step.done === true) break;
        yield validator.accept(step.value);
      }
      validator.result();
      finished = true;
    } catch (e) {
      error = normalize(e, ctl.why);
    } finally {
      if (!finished && iterator?.return !== undefined) {
        // Release the adapter's request; do not wait on an adapter that hangs.
        ctl.controller.abort();
        void Promise.resolve()
          .then(() => iterator?.return?.())
          .catch(() => undefined);
      }
      ctl.dispose();
      // The consumer stopped early (break/return) when we get here with neither.
      const outcome = error === undefined ? (finished ? "completed" : "cancelled") : outcomeOf(error);
      await record(run, valid.model, validator.usage, outcome);
      log({
        ...base(run, valid.model, "stream"),
        event: "request_end",
        outcome,
        ...(error === undefined ? {} : { errorCode: error.code, message: error.message }),
        ...(validator.usage === undefined ? {} : { usage: validator.usage }),
        durationMs: now() - started,
      });
    }
    if (error !== undefined) throw error;
  }
}

function read(o: object, key: string): unknown {
  try {
    return (o as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** Run a `generate` result through the stream grammar, so both paths are held to the same rules. */
function checkResult(raw: unknown, limits: StreamLimits): GenerateResult {
  if (typeof raw !== "object" || raw === null) throw new ProviderError("invalid_response", { reason: "malformed_result" });
  const r = raw as Partial<GenerateResult>;
  if (!Array.isArray(r.content)) throw new ProviderError("invalid_response", { reason: "malformed_result" });
  const v = new StreamValidator(limits);
  v.accept(r.id === undefined ? { type: "message_start", model: r.model } : { type: "message_start", id: r.id, model: r.model });
  r.content.forEach((b: unknown, index: number) => {
    const block = b as Record<string, unknown>;
    if (block?.["type"] === "text") {
      v.accept({ type: "content_block_start", index, block: { type: "text" } });
      v.accept({ type: "content_block_delta", index, delta: { type: "text", text: block["text"] } });
    } else if (block?.["type"] === "tool_use") {
      v.accept({ type: "content_block_start", index, block: { type: "tool_use", id: block["id"], name: block["name"] } });
      let json: string;
      try {
        json = JSON.stringify(block["input"]) ?? "";
      } catch {
        throw new ProviderError("invalid_response", { reason: "tool_input_not_json" });
      }
      v.accept({ type: "content_block_delta", index, delta: { type: "tool_input", partialJson: json } });
    } else {
      throw new ProviderError("invalid_response", { reason: "malformed_result" });
    }
    v.accept({ type: "content_block_stop", index });
  });
  v.accept({ type: "message_stop", stopReason: r.stopReason, usage: r.usage });
  return v.result();
}
