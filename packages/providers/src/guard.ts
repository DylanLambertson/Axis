// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { ProviderError, sanitizeProviderError } from "./errors.js";
import { abortError, RequestControl, type AbortWhy } from "./guard-control.js";
import { charge, costing, failedBudgets, GUARD_ONLY, nextRequestSeq, PROBE_USAGE, type Prepared } from "./guard-billing.js";
import { estimateInputTokens, requestChars } from "./guard-estimate.js";
import { checkResult } from "./guard-result.js";
import { descriptorSchema, listedModelsSchema, tokenCountSchema } from "./guard-schemas.js";
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  type GuardMode,
  type GuardOptions,
  type GuardedProvider,
  type ProviderLogRecord,
  type RunOptions,
  type Timers,
} from "./guard-types.js";
import { limitOf, read } from "./guard-util.js";
import { stringsIn } from "./redaction.js";
import { StreamValidator, type StreamLimits } from "./stream.js";
import {
  PROVIDER_ADAPTER_API_VERSION,
  ZERO_USAGE,
  modelCapabilitiesSchema,
  modelIdSchema,
  type AdapterDescriptor,
  type CallOptions,
  type GenerateRequest,
  type GenerateResult,
  type ModelCapabilities,
  type ProviderAdapter,
  type StreamEvent,
  type Usage,
} from "./types.js";
import { checkCapabilities, validateRequest, type ValidRequest } from "./validate.js";

// The guard's public surface lives in focused modules; this file keeps the
// entry point (`index.ts` re-exports it) and the `guardProvider` closure.
export type { GuardLimits, GuardMode, GuardOptions, GuardedProvider, ProviderLogRecord, RunOptions, Timers } from "./guard-types.js";
export { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, MAX_LISTED_MODELS, MAX_TIMEOUT_MS } from "./guard-types.js";
export { estimateInputTokens } from "./guard-estimate.js";

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

  const { safeCost, reserveCost } = costing(adapter);

  /** Common log fields. Descriptor fields are adapter data and are redacted on every line (R1). */
  const base = (runId: string, model: string, mode: GuardMode) => ({
    runId,
    providerId: redactor.redact(d.providerId),
    connectionId: redactor.redact(d.connectionId),
    destination: redactor.redact(d.destination.origin ?? d.destination.description),
    model,
    mode,
  });

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
