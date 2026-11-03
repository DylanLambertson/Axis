// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { inspect } from "node:util";
import {
  ProviderError,
  createSecretRedactor,
  guardProvider,
  type GenerateRequest,
  type GuardLimits,
  type GuardedProvider,
  type ProviderAdapter,
  type ProviderLogRecord,
  type RunOptions,
  type StreamEvent,
  type BudgetHook,
} from "@axis/providers";
import { ANTHROPIC_KEY_PATTERN, createAnthropicAdapter, type AnthropicAdapterOptions, type AnthropicAdapter } from "../../src/index.js";
import { MODEL } from "./scenarios.js";
import { fakeFetch, jsonResponse, modelInfo, type FakeFetch, type Handler } from "./transport.js";

// Low-entropy stand-in for an API credential. Not key-shaped on purpose.
export const CREDENTIAL = "holdout-zq7x-standin-0001";
/** A key-shaped string built at run time, to test the pattern without a literal that looks like a key. */
export const PATTERN_KEY = ["sk", "ant", "x".repeat(12)].join("-");

export const live = (): AbortSignal => new AbortController().signal;

export function req(extra: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    model: MODEL,
    messages: [{ role: "user", content: [{ type: "text", text: "hello there" }] }],
    maxOutputTokens: 256,
    ...extra,
  };
}

/** Serve the model endpoint, then hand every other request to `handler`. */
export function withModel(handler: Handler, info: Record<string, unknown> = modelInfo(MODEL)): Handler {
  return (call, counter) => {
    const url = new URL(call.url);
    if (call.init.method === "GET" && url.pathname === `/v1/models/${MODEL}`) return jsonResponse(counter, 200, info);
    return handler(call, counter);
  };
}

export interface Made {
  readonly adapter: AnthropicAdapter;
  readonly fake: FakeFetch;
}

export function make(handler: Handler, extra: Partial<AnthropicAdapterOptions> = {}): Made {
  const fake = fakeFetch(withModel(handler));
  const adapter = createAnthropicAdapter({ connectionId: "anthropic-test", apiKey: () => CREDENTIAL, fetch: fake.fetch, ...extra });
  return { adapter, fake };
}

export function redactor() {
  return createSecretRedactor({ secrets: () => [CREDENTIAL], patterns: [ANTHROPIC_KEY_PATTERN] });
}

export function guarded(adapter: ProviderAdapter, limits?: GuardLimits): { g: GuardedProvider; logs: ProviderLogRecord[] } {
  const logs: ProviderLogRecord[] = [];
  const g = guardProvider(adapter, { redactor: redactor(), log: (r) => logs.push(r), ...(limits === undefined ? {} : { limits }) });
  return { g, logs };
}

export const run = (budget?: BudgetHook): RunOptions => ({ runId: "run-1", signal: live(), ...(budget === undefined ? {} : { budget }) });

export async function drain(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

export async function failure(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof ProviderError)) throw new Error(`expected a ProviderError, got ${e instanceof Error ? e.name : typeof e}`);
    return e;
  }
  throw new Error("expected a failure");
}

/** Everything a log sink or UI could print for an error. */
export function views(e: unknown): string[] {
  return [
    e instanceof Error ? e.message : "",
    String(e),
    JSON.stringify(e),
    e instanceof Error ? (e.stack ?? "") : "",
    inspect(e, { depth: Infinity, showHidden: true, getters: true }),
  ];
}

/** The forms of the credential and key-shaped text a leak could take. */
export function secretForms(): string[] {
  return [CREDENTIAL, encodeURIComponent(CREDENTIAL), PATTERN_KEY];
}
