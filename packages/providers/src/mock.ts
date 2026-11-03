// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { JsonValue } from "@axis/protocol";
import { ProviderError, type ProviderErrorCode } from "./errors.js";
import { stringsIn } from "./redaction.js";
import { collectStream } from "./stream.js";
import {
  FEATURES,
  PROVIDER_ADAPTER_API_VERSION,
  type CallOptions,
  type CapabilityState,
  type CostEstimate,
  type Feature,
  type GenerateRequest,
  type ModelCapabilities,
  type ModelInfo,
  type ProviderAdapter,
  type StopReason,
  type StreamEvent,
  type TokenCount,
  type Usage,
} from "./types.js";
import { validateRequest, type ValidRequest } from "./validate.js";

/**
 * What the mock does for one request. It stands in for the wire: an `error`
 * is what an HTTP adapter would see as an error response, `malformed` a
 * corrupt stream, `hang` a stream that stops sending.
 */
export type MockReply =
  | { readonly kind: "echo" }
  | { readonly kind: "text"; readonly text: string; readonly stopReason?: Exclude<StopReason, "tool_use"> }
  | {
      readonly kind: "tool_use";
      readonly name: string;
      readonly input: { readonly [key: string]: JsonValue };
      readonly id?: string;
      /** Text before the tool call. */
      readonly text?: string;
    }
  | {
      readonly kind: "error";
      readonly code: ProviderErrorCode;
      readonly retryAfterMs?: number;
      readonly status?: number;
      /** Simulated provider body. The mock never surfaces it, as a real adapter must not. */
      readonly body?: string;
      /** Fail after this much text has streamed, instead of before the first event. */
      readonly afterText?: string;
    }
  | { readonly kind: "hang"; readonly text?: string }
  | { readonly kind: "malformed" };

export interface MockModel {
  readonly id: string;
  readonly displayName?: string;
  /** Overrides on the default feature report. */
  readonly features?: Partial<Record<Feature, CapabilityState>>;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
}

export interface MockProviderOptions {
  readonly connectionId?: string;
  readonly providerId?: string;
  readonly models?: readonly MockModel[];
  /** Replies used in order, one per request; after they run out, `respond` decides. */
  readonly replies?: ReadonlyArray<MockReply | ((request: ValidRequest) => MockReply)>;
  /** Fallback for requests beyond `replies`. Default: echo the last user text. */
  readonly respond?: (request: ValidRequest) => MockReply;
  /** Characters per streamed delta. */
  readonly chunkChars?: number;
  /** Prices in micro-USD per token; `null` makes the mock unable to price (for budget tests). */
  readonly pricing?: { readonly inputMicroUsdPerToken: number; readonly outputMicroUsdPerToken: number } | null;
  /** When set, `validateConnection` reports this error (for example `authentication`). */
  readonly connectionError?: ProviderErrorCode;
}

export const MOCK_PROVIDER_ID = "mock";
export const MOCK_DEFAULT_MODEL = "mock-model";
export const MOCK_PROVIDER_API_VERSION = "mock-1";

const DEFAULT_FEATURES: Readonly<Record<Feature, CapabilityState>> = {
  streaming: "supported",
  systemPrompt: "supported",
  toolUse: "supported",
  parallelToolUse: "unsupported",
  toolChoice: "supported",
  imageInput: "unsupported",
  stopSequences: "supported",
  temperature: "supported",
  structuredOutput: "unsupported",
  reasoning: "unsupported",
  promptCaching: "unsupported",
  tokenCounting: "supported",
  costEstimation: "supported",
};

export interface MockProvider extends ProviderAdapter {
  /** Every request that reached the simulated wire, after validation, in order. */
  readonly requests: readonly ValidRequest[];
  /** Streams whose simulated wire request is still open. */
  readonly openStreams: number;
  /** Queue another reply. */
  enqueue(reply: MockReply | ((request: ValidRequest) => MockReply)): void;
}

/** Deterministic token estimate: one token per four UTF-16 units, rounded up. */
function tokensFor(chars: number): number {
  return Math.ceil(chars / 4);
}

function lastUserText(r: ValidRequest): string {
  for (let i = r.messages.length - 1; i >= 0; i--) {
    const m = r.messages[i];
    if (m?.role !== "user") continue;
    const texts = m.content.flatMap((b) => (b.type === "text" ? [b.text] : []));
    if (texts.length > 0) return texts.join("\n");
  }
  return "";
}

function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    let end = Math.min(i + size, text.length);
    // Never split a surrogate pair across deltas.
    const c = text.charCodeAt(end - 1);
    if (end < text.length && c >= 0xd800 && c <= 0xdbff) end += 1;
    out.push(text.slice(i, end));
    i = end - size;
  }
  return out;
}

/**
 * A scripted, network-free provider adapter. It keeps the full adapter
 * contract, so it runs the same contract suite as real adapters, and it is the
 * provider the Phase 1b gate uses before the Anthropic adapter (ROADMAP 1b/L1).
 */
export function createMockProvider(options: MockProviderOptions = {}): MockProvider {
  const models = options.models ?? [{ id: MOCK_DEFAULT_MODEL, displayName: "Mock model" }];
  const queue = [...(options.replies ?? [])];
  const respond = options.respond ?? ((): MockReply => ({ kind: "echo" }));
  const chunkChars = Math.max(1, options.chunkChars ?? 8);
  const pricing = options.pricing === undefined ? { inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 5 } : options.pricing;
  const requests: ValidRequest[] = [];
  let openStreams = 0;
  let seq = 0;

  const findModel = (id: string): MockModel => {
    const m = models.find((x) => x.id === id);
    if (m === undefined) throw new ProviderError("not_found", { status: 404 });
    return m;
  };

  const capabilitiesOf = (m: MockModel): ModelCapabilities => {
    const features = { ...DEFAULT_FEATURES, ...m.features };
    if (pricing === null) features.costEstimation = "unsupported";
    const limits: { contextWindowTokens?: number; maxOutputTokens?: number } = {
      contextWindowTokens: m.contextWindowTokens ?? 200_000,
      maxOutputTokens: m.maxOutputTokens ?? 32_000,
    };
    return {
      modelId: m.id,
      providerApiVersion: MOCK_PROVIDER_API_VERSION,
      features: Object.fromEntries(FEATURES.map((f) => [f, features[f]])) as Record<Feature, CapabilityState>,
      limits,
    };
  };

  const cancelled = (signal: AbortSignal): void => {
    if (signal.aborted) throw new ProviderError("cancelled");
  };

  const inputTokens = (r: ValidRequest): number => {
    let n = 0;
    for (const s of stringsIn(r.messages)) n += s.length;
    if (r.system !== undefined) n += r.system.length;
    return tokensFor(n);
  };

  /** Validate, then take the next scripted reply. Counts as a provider request. */
  const begin = (request: GenerateRequest, mode: "generate" | "stream", signal: AbortSignal): [ValidRequest, MockReply] => {
    cancelled(signal);
    const model = findModel(typeof request.model === "string" ? request.model : "");
    const valid = validateRequest(request, capabilitiesOf(model), mode);
    const next = queue.shift() ?? respond;
    const reply = typeof next === "function" ? next(valid) : next;
    requests.push(structuredClone(valid));
    return [valid, reply];
  };

  async function* events(valid: ValidRequest, reply: MockReply, signal: AbortSignal): AsyncGenerator<StreamEvent, void, undefined> {
    openStreams += 1;
    try {
      const tick = async (): Promise<void> => {
        await Promise.resolve();
        cancelled(signal);
      };
      if (reply.kind === "malformed") throw new ProviderError("invalid_response", { reason: "malformed_event" });
      if (reply.kind === "error" && reply.afterText === undefined) {
        throw new ProviderError(reply.code, {
          ...(reply.status === undefined ? {} : { status: reply.status }),
          ...(reply.retryAfterMs === undefined ? {} : { retryAfterMs: reply.retryAfterMs }),
        });
      }
      const input = inputTokens(valid);
      let outputChars = 0;
      const usage = (): Usage => ({ inputTokens: input, outputTokens: tokensFor(outputChars) });

      seq += 1;
      yield { type: "message_start", id: `mock-msg-${seq}`, model: valid.model };
      await tick();
      yield { type: "usage", usage: usage() };

      let index = 0;
      const text =
        reply.kind === "echo"
          ? `Mock reply: ${lastUserText(valid)}`
          : reply.kind === "text"
            ? reply.text
            : reply.kind === "tool_use" || reply.kind === "hang"
              ? reply.text
              : reply.kind === "error"
                ? reply.afterText
                : undefined;
      if (text !== undefined) {
        await tick();
        yield { type: "content_block_start", index, block: { type: "text" } };
        for (const part of chunks(text, chunkChars)) {
          await tick();
          outputChars += part.length;
          yield { type: "content_block_delta", index, delta: { type: "text", text: part } };
        }
        if (reply.kind === "hang") {
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new ProviderError("cancelled");
        }
        if (reply.kind === "error") {
          throw new ProviderError(reply.code, reply.retryAfterMs === undefined ? {} : { retryAfterMs: reply.retryAfterMs });
        }
        await tick();
        yield { type: "content_block_stop", index };
        index += 1;
      } else if (reply.kind === "hang") {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new ProviderError("cancelled");
      }

      let stopReason: StopReason = "end_turn";
      if (reply.kind === "tool_use") {
        const json = JSON.stringify(reply.input);
        await tick();
        yield { type: "content_block_start", index, block: { type: "tool_use", id: reply.id ?? `mock-tool-${seq}-${index}`, name: reply.name } };
        for (const part of chunks(json, chunkChars)) {
          await tick();
          outputChars += part.length;
          yield { type: "content_block_delta", index, delta: { type: "tool_input", partialJson: part } };
        }
        await tick();
        yield { type: "content_block_stop", index };
        stopReason = "tool_use";
      } else if (reply.kind === "text" && reply.stopReason !== undefined) {
        stopReason = reply.stopReason;
      }
      await tick();
      yield { type: "message_stop", stopReason, usage: usage() };
    } finally {
      openStreams -= 1;
    }
  }

  const adapter: MockProvider = {
    descriptor: Object.freeze({
      apiVersion: PROVIDER_ADAPTER_API_VERSION,
      providerId: options.providerId ?? MOCK_PROVIDER_ID,
      displayName: "Mock provider",
      connectionId: options.connectionId ?? "mock-connection",
      destination: Object.freeze({ description: "Local mock provider; no data leaves the device." }),
    }),
    get requests() {
      return requests;
    },
    get openStreams() {
      return openStreams;
    },
    enqueue(reply) {
      queue.push(reply);
    },

    async listModels(opts: CallOptions): Promise<readonly ModelInfo[]> {
      cancelled(opts.signal);
      return models.map((m) => (m.displayName === undefined ? { id: m.id } : { id: m.id, displayName: m.displayName }));
    },

    async getCapabilities(model: string, opts: CallOptions): Promise<ModelCapabilities> {
      cancelled(opts.signal);
      return capabilitiesOf(findModel(model));
    },

    async validateConnection(opts: CallOptions) {
      cancelled(opts.signal);
      return options.connectionError === undefined ? { ok: true } : { ok: false, error: new ProviderError(options.connectionError) };
    },

    async generate(request, opts) {
      const [valid, reply] = begin(request, "generate", opts.signal);
      return collectStream(events(valid, reply, opts.signal));
    },

    stream(request, opts) {
      return {
        async *[Symbol.asyncIterator]() {
          const [valid, reply] = begin(request, "stream", opts.signal);
          yield* events(valid, reply, opts.signal);
        },
      };
    },

    async countTokens(request: GenerateRequest, opts: CallOptions): Promise<TokenCount> {
      cancelled(opts.signal);
      const valid = validateRequest(request, capabilitiesOf(findModel(typeof request.model === "string" ? request.model : "")));
      return { inputTokens: inputTokens(valid) };
    },

    estimateCost(model: string, usage: Usage): CostEstimate | undefined {
      if (pricing === null || !models.some((m) => m.id === model)) return undefined;
      const input = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
      return { microUsd: input * pricing.inputMicroUsdPerToken + usage.outputTokens * pricing.outputMicroUsdPerToken };
    },
  };
  return adapter;
}
