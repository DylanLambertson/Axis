// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { DETAIL_KEYS, ProviderError, isProviderError } from "../src/errors.js";
import type { GenerateRequest, GenerateResult, ModelCapabilities, StreamEvent } from "../src/types.js";

export const MARKER = "axis-contract-request-marker";

export function request(model: string, extra: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    model,
    system: "You are a contract test.",
    messages: [{ role: "user", content: [{ type: "text", text: `hello ${MARKER}` }] }],
    maxOutputTokens: 256,
    ...extra,
  };
}

export const TOOL = {
  name: "read_file",
  description: "Read a file in the workspace.",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

export async function rejection(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    assert.ok(isProviderError(e), `expected a ProviderError, got ${e instanceof Error ? e.name : typeof e}`);
    return e;
  }
  assert.fail("expected the call to fail");
}

export async function drain(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

export function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(handle));
}

export async function settles(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return check();
}

const ERROR_OWN_KEYS: ReadonlySet<string> = new Set(["stack", "message", "name", "code", "retryable", "details"]);
const DETAIL_KEY_SET: ReadonlySet<string> = new Set(DETAIL_KEYS);

/**
 * An error is exactly a ProviderError with its known fields, and nothing a
 * log sink would print contains a canary (S9). `util.inspect` with hidden
 * properties and getters is what common loggers see; `JSON.stringify` alone
 * goes through `toJSON` and would hide extra properties.
 */
export function assertNoLeak(err: ProviderError, ...canaries: string[]): void {
  assert.equal(Object.getPrototypeOf(err), ProviderError.prototype, "errors are plain ProviderError instances");
  for (const key of Reflect.ownKeys(err)) {
    assert.ok(typeof key === "string" && ERROR_OWN_KEYS.has(key), `unexpected own property on the error: ${String(key)}`);
  }
  for (const key of Reflect.ownKeys(err.details)) {
    assert.ok(typeof key === "string" && DETAIL_KEY_SET.has(key), `unexpected detail key: ${String(key)}`);
  }
  const views = [err.message, String(err), JSON.stringify(err), err.stack ?? "", inspect(err, { depth: Infinity, showHidden: true, getters: true })];
  for (const s of views) {
    for (const c of canaries) assert.ok(!s.includes(c), "error text contains a canary (provider body or credential)");
    assert.ok(!s.includes(MARKER), "error text contains request content");
  }
}

export function textOf(r: GenerateResult): string {
  return r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
}

export function assertUsage(r: GenerateResult): void {
  for (const n of [r.usage.inputTokens, r.usage.outputTokens]) assert.ok(Number.isSafeInteger(n) && n >= 0);
}

/** A request that uses one feature the model does not report as supported, if the suite can build one. */
export function requestUsingMissingFeature(model: string, caps: ModelCapabilities): GenerateRequest | undefined {
  const f = caps.features;
  if (f.imageInput !== "supported") {
    return request(model, {
      messages: [{ role: "user", content: [{ type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" }] }],
    });
  }
  if (f.stopSequences !== "supported") return request(model, { stopSequences: ["END"] });
  if (f.temperature !== "supported") return request(model, { temperature: 0.5 });
  if (f.toolChoice !== "supported") return request(model, { tools: [TOOL], toolChoice: "any" });
  return undefined;
}
