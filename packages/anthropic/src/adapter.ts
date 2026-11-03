// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import {
  FEATURES,
  PROVIDER_ADAPTER_API_VERSION,
  ProviderError,
  collectStream,
  isProviderError,
  modelIdSchema,
  validateRequest,
  type CallOptions,
  type CapabilityState,
  type ConnectionCheck,
  type CostEstimate,
  type Feature,
  type GenerateRequest,
  type GenerateResult,
  type ModelCapabilities,
  type ModelInfo,
  type ProviderAdapter,
  type StreamEvent,
  type TokenCount,
  type Usage,
  type ValidRequest,
} from "@axis/providers";
import { errorFromResponse } from "./errors.js";
import { EventMapper } from "./events.js";
import { parseJson, readText } from "./json.js";
import {
  ANTHROPIC_ORIGIN,
  ANTHROPIC_VERSION,
  CAPABILITY_TTL_MS,
  MAX_CACHED_CAPABILITIES,
  MAX_LISTED_MODELS,
  MAX_MODEL_PAGES,
  resolveLimits,
  type AnthropicLimits,
} from "./limits.js";
import { priceUsage, type Pricing } from "./pricing.js";
import { checkOwnOptions, countTokensBody, messagesBody, serialize, PROVIDER_OPTIONS_KEY } from "./request.js";
import { EventCounters, parseSse } from "./sse.js";
import { BodyStream, discard, type FetchLike, type ResponseLike } from "./transport.js";

export const ANTHROPIC_PROVIDER_ID = "anthropic";

/** A provider-issued API key as it appears in text, for the redactor's pattern list (PRV-2). */
export const ANTHROPIC_KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]{8,}/;

/** Printable ASCII with no whitespace or control characters: a value that cannot split a header. */
const KEY_RE = /^[\x21-\x7e]{8,4096}$/;

export interface AnthropicAdapterOptions {
  /** The connection this instance is bound to (one adapter per connection). */
  readonly connectionId: string;
  /**
   * Returns the API key for one request. Called immediately before it; the
   * adapter never stores the result. `purpose` is what the vault's `reveal`
   * takes, so its audit event says why the key was read. The daemon backs this
   * with the vault (PRV-2).
   */
  readonly apiKey: (purpose: KeyPurpose) => string | Promise<string>;
  /** Node's global `fetch`, or a fake in tests. Called only with URLs built from the fixed origin. */
  readonly fetch: FetchLike;
  /** Prices per model from reviewed configuration. Without it every request is unpriced and cost caps fail closed. */
  readonly pricing?: (model: string) => Pricing | undefined;
  readonly limits?: Partial<AnthropicLimits>;
  /** Clock for the capability cache and the thinking progress events. */
  readonly now?: () => number;
  /** Spacing of the progress events sent while the model streams thinking the adapter does not expose. Default 5,000 ms. */
  readonly keepAliveMs?: number;
}

/** Why the key is being read: the same words as the vault's `SecretPurpose`. */
export type KeyPurpose = "provider_request" | "validate_connection";

export interface AnthropicAdapter extends ProviderAdapter {
  /** Counts for tests and diagnostics; never content. */
  readonly stats: { readonly ignoredEvents: number };
}

const asObject = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const posInt = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined);

function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

function headerOf(res: ResponseLike, name: string): string | null {
  try {
    const v = res.headers.get(name);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Every failure leaves the adapter as a `ProviderError`; anything else becomes a fixed `internal`. */
function asProviderError(e: unknown): ProviderError {
  return isProviderError(e) ? e : new ProviderError("internal");
}

export function createAnthropicAdapter(options: AnthropicAdapterOptions): AnthropicAdapter {
  const limits = resolveLimits(options.limits);
  const now = options.now ?? ((): number => Date.now());
  const cache = new Map<string, { readonly caps: ModelCapabilities; readonly expires: number }>();
  let ignoredEvents = 0;

  const keepAliveMs = options.keepAliveMs ?? EventMapper.DEFAULT_KEEPALIVE_MS;
  if (!Number.isSafeInteger(keepAliveMs) || keepAliveMs < 1) throw new RangeError("keepAliveMs must be a positive safe integer");

  const getKey = async (purpose: KeyPurpose): Promise<string> => {
    let key: unknown;
    try {
      key = await options.apiKey(purpose);
    } catch {
      throw new ProviderError("authentication", { reason: "no_credential" });
    }
    if (typeof key !== "string" || key === "") throw new ProviderError("authentication", { reason: "no_credential" });
    if (!KEY_RE.test(key)) throw new ProviderError("authentication", { reason: "bad_key_format" });
    return key;
  };

  /**
   * One HTTP request to the fixed origin. `path` is built by this module from
   * constants and an encoded model id. Redirects are never followed and the
   * key goes out exactly once (ANT-1).
   */
  const send = async (
    method: "GET" | "POST",
    path: string,
    body: string | undefined,
    accept: string,
    signal: AbortSignal,
    purpose: KeyPurpose = "provider_request",
  ): Promise<BodyStream> => {
    if (signal.aborted) throw new ProviderError("cancelled");
    const key = await getKey(purpose);
    const url = `${ANTHROPIC_ORIGIN}${path}`;
    const headers: Record<string, string> = {
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION,
      accept,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: ResponseLike;
    try {
      res = await options.fetch(url, { method, headers, ...(body === undefined ? {} : { body }), redirect: "manual", signal });
    } catch {
      throw signal.aborted ? new ProviderError("cancelled") : new ProviderError("network");
    }
    if (signal.aborted) {
      discard(res);
      throw new ProviderError("cancelled");
    }
    // A redirect is refused without reading it or its Location header. The
    // checks past the status cover a fetch that followed one anyway.
    if (
      (res.status >= 300 && res.status < 400) ||
      res.type === "opaqueredirect" ||
      res.redirected === true ||
      (typeof res.url === "string" && res.url !== "" && !sameUrl(res.url, url))
    ) {
      discard(res);
      throw new ProviderError("invalid_response", { reason: "redirect", ...(res.status >= 100 && res.status <= 599 ? { status: res.status } : {}) });
    }
    if (res.status !== 200) throw await errorFromResponse(res, signal, limits);
    if (res.body === null) throw new ProviderError("invalid_response", { reason: "no_body" });
    // A captive portal or proxy answering 200 with a page is not a provider response (N3).
    const type = headerOf(res, "content-type");
    if (type !== null && !type.toLowerCase().startsWith(accept)) {
      discard(res);
      throw new ProviderError("invalid_response", { reason: "unexpected_content_type" });
    }
    return new BodyStream(res.body, signal, limits.maxStreamBytes);
  };

  const getJson = async (path: string, signal: AbortSignal, purpose: KeyPurpose = "provider_request"): Promise<unknown> => {
    const body = await send("GET", path, undefined, "application/json", signal, purpose);
    try {
      return parseJson(await readText(body, limits.maxJsonBodyBytes), limits.maxEventJsonDepth, "malformed_response");
    } finally {
      await body.close();
    }
  };

  const capabilitiesFrom = (model: string, info: unknown): ModelCapabilities => {
    const o = asObject(info);
    if (o === undefined) throw new ProviderError("invalid_response", { reason: "malformed_model" });
    const image = asObject(asObject(o["capabilities"])?.["image_input"])?.["supported"];
    const priced = options.pricing?.(model) !== undefined;
    const state: Record<Feature, CapabilityState> = {
      streaming: "supported",
      systemPrompt: "supported",
      toolUse: "supported",
      parallelToolUse: "supported",
      // Some models reject forced tool use and the Models API does not report it; unknown is refused when used.
      toolChoice: "unknown",
      imageInput: image === true ? "supported" : image === false ? "unsupported" : "unknown",
      stopSequences: "supported",
      temperature: "unknown",
      // The adapter sends none of the fields that enable these.
      structuredOutput: "unsupported",
      reasoning: "unsupported",
      promptCaching: "unsupported",
      tokenCounting: "supported",
      costEstimation: priced ? "supported" : "unsupported",
    };
    const limitsOut: { contextWindowTokens?: number; maxOutputTokens?: number } = {};
    const ctx = posInt(o["max_input_tokens"]);
    const out = posInt(o["max_tokens"]);
    if (ctx !== undefined) limitsOut.contextWindowTokens = ctx;
    if (out !== undefined) limitsOut.maxOutputTokens = out;
    return {
      modelId: model,
      providerApiVersion: ANTHROPIC_VERSION,
      features: Object.fromEntries(FEATURES.map((f) => [f, state[f]])) as Record<Feature, CapabilityState>,
      limits: limitsOut,
    };
  };

  const capabilities = async (model: string, signal: AbortSignal): Promise<ModelCapabilities> => {
    const parsed = modelIdSchema.safeParse(model);
    // `.` and `..` survive URL encoding and would walk the path (N2).
    if (!parsed.success || model === "." || model === "..") throw new ProviderError("invalid_request", { message: 'The request field "model" is invalid.', reason: "schema" });
    const hit = cache.get(model);
    if (hit !== undefined && hit.expires > now()) return hit.caps;
    const info = await getJson(`/v1/models/${encodeURIComponent(model)}`, signal);
    const caps = capabilitiesFrom(model, info);
    if (cache.size >= MAX_CACHED_CAPABILITIES) cache.delete(cache.keys().next().value as string);
    cache.set(model, { caps, expires: now() + CAPABILITY_TTL_MS });
    return caps;
  };

  /** Validate before anything is sent: schema, our options, then the model's capabilities. */
  const prepare = async (request: GenerateRequest, mode: "generate" | "stream", signal: AbortSignal): Promise<ValidRequest> => {
    if (signal.aborted) throw new ProviderError("cancelled");
    const first = validateRequest(request);
    checkOwnOptions(first);
    const caps = await capabilities(first.model, signal);
    return validateRequest(request, caps, mode);
  };

  async function* eventsOf(valid: ValidRequest, signal: AbortSignal): AsyncGenerator<StreamEvent, void, undefined> {
    const body = await send("POST", "/v1/messages", serialize(messagesBody(valid), limits.maxRequestBytes), "text/event-stream", signal);
    const counters = new EventCounters(limits);
    const mapper = new EventMapper(counters, now, keepAliveMs);
    try {
      for await (const sse of parseSse(body, limits, counters)) {
        for (const ev of mapper.map(parseJson(sse.data, limits.maxEventJsonDepth))) {
          // One event of the wire can map to several: let an abort that arrived meanwhile win over the next one.
          await Promise.resolve();
          if (signal.aborted) throw new ProviderError("cancelled");
          yield ev;
        }
        if (mapper.finished) return;
      }
      throw new ProviderError("network", { reason: "truncated_stream" });
    } finally {
      ignoredEvents += counters.ignored;
      await body.close();
    }
  }

  const adapter: AnthropicAdapter = {
    descriptor: Object.freeze({
      apiVersion: PROVIDER_ADAPTER_API_VERSION,
      providerId: ANTHROPIC_PROVIDER_ID,
      displayName: "Anthropic (Claude API)",
      connectionId: options.connectionId,
      destination: Object.freeze({
        origin: ANTHROPIC_ORIGIN,
        description: "Anthropic Claude API (api.anthropic.com). Prompts, tool results and attached images are sent to Anthropic.",
      }),
    }),
    get stats() {
      return { ignoredEvents };
    },

    async listModels(opts: CallOptions): Promise<readonly ModelInfo[]> {
      try {
        const seen = new Set<string>();
        const models: ModelInfo[] = [];
        let after: string | undefined;
        for (let page = 0; page < MAX_MODEL_PAGES; page++) {
          const q = `limit=1000${after === undefined ? "" : `&after_id=${encodeURIComponent(after)}`}`;
          const json = asObject(await getJson(`/v1/models?${q}`, opts.signal));
          const data = json?.["data"];
          if (json === undefined || !Array.isArray(data)) throw new ProviderError("invalid_response", { reason: "malformed_models" });
          for (const item of data) {
            const m = asObject(item);
            const id = modelIdSchema.safeParse(m?.["id"]);
            if (m === undefined || !id.success || seen.has(id.data)) continue;
            seen.add(id.data);
            const name = m["display_name"];
            models.push(typeof name === "string" && name.length > 0 && name.length <= 256 ? { id: id.data, displayName: name } : { id: id.data });
            if (models.length >= MAX_LISTED_MODELS) return models;
          }
          const last = json["last_id"];
          if (json["has_more"] !== true || typeof last !== "string" || last === after) break;
          after = last;
        }
        return models;
      } catch (e) {
        throw asProviderError(e);
      }
    },

    async getCapabilities(model: string, opts: CallOptions): Promise<ModelCapabilities> {
      try {
        return await capabilities(model, opts.signal);
      } catch (e) {
        throw asProviderError(e);
      }
    },

    async validateConnection(opts: CallOptions): Promise<ConnectionCheck> {
      try {
        await getJson("/v1/models?limit=1", opts.signal, "validate_connection");
        return { ok: true };
      } catch (e) {
        const error = asProviderError(e);
        if (error.code === "cancelled") throw error;
        return { ok: false, error };
      }
    },

    async generate(request: GenerateRequest, opts: CallOptions): Promise<GenerateResult> {
      try {
        const valid = await prepare(request, "generate", opts.signal);
        return await collectStream(eventsOf(valid, opts.signal));
      } catch (e) {
        throw asProviderError(e);
      }
    },

    stream(request: GenerateRequest, opts: CallOptions): AsyncIterable<StreamEvent> {
      return {
        async *[Symbol.asyncIterator]() {
          try {
            const valid = await prepare(request, "stream", opts.signal);
            yield* eventsOf(valid, opts.signal);
          } catch (e) {
            throw asProviderError(e);
          }
        },
      };
    },

    async countTokens(request: GenerateRequest, opts: CallOptions): Promise<TokenCount> {
      try {
        const valid = await prepare(request, "generate", opts.signal);
        const body = await send("POST", "/v1/messages/count_tokens", serialize(countTokensBody(valid), limits.maxRequestBytes), "application/json", opts.signal);
        try {
          const json = asObject(parseJson(await readText(body, limits.maxJsonBodyBytes), limits.maxEventJsonDepth, "malformed_response"));
          const n = json?.["input_tokens"];
          if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new ProviderError("invalid_response", { reason: "malformed_token_count" });
          return { inputTokens: n };
        } finally {
          await body.close();
        }
      } catch (e) {
        throw asProviderError(e);
      }
    },

    estimateCost(model: string, usage: Usage): CostEstimate | undefined {
      try {
        return priceUsage(options.pricing?.(model), usage);
      } catch {
        return undefined;
      }
    },
  };
  return adapter;
}

export { PROVIDER_OPTIONS_KEY };
