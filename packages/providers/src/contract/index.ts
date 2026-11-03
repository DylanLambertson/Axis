// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
/**
 * The provider adapter contract suite (`@axis/providers/contract`).
 *
 * Every adapter runs this suite against a harness that scripts its "wire":
 * the mock provider scripts replies directly; an HTTP adapter (ticket 9)
 * injects a fake transport that serves recorded responses and counts
 * requests. The suite needs no network.
 *
 * This entry point imports `node:test` and is test support only: it is not
 * daemon code and is not staged into the Code OSS tree (ADR 0005 D3).
 */
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { JsonValue } from "@axis/protocol";
import { ProviderError, isProviderError, isRetryableCode, type ProviderErrorCode } from "../errors.js";
import { StreamValidator, collectStream } from "../stream.js";
import {
  PROVIDER_ADAPTER_API_VERSION,
  modelCapabilitiesSchema,
  type GenerateRequest,
  type GenerateResult,
  type ModelCapabilities,
  type ProviderAdapter,
  type StreamEvent,
} from "../types.js";

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
   * An error response. The harness must put `canary` into the simulated
   * response body (and headers, where it can), to prove the adapter does not
   * echo bodies into errors (ANT-1).
   */
  | { readonly kind: "error"; readonly code: ContractErrorCode; readonly retryAfterMs?: number }
  /** A stream that sends `text` and then fails with `overloaded`. */
  | { readonly kind: "mid_stream_error"; readonly text: string }
  /** A response that starts and then sends nothing until cancelled. */
  | { readonly kind: "hang" }
  /** A corrupt response that cannot be parsed. */
  | { readonly kind: "malformed" };

export interface ContractFixture {
  /** A fresh adapter whose next provider request gets the scenario. */
  readonly adapter: ProviderAdapter;
  /** A model the connection offers, supporting streaming, system prompts and tool use. */
  readonly model: string;
  /** Provider requests made by `generate` and `stream` so far. */
  requestCount(): number;
  /** Responses still open on the wire. Optional; checks that need it are skipped without it. */
  openStreams?(): number;
}

export interface ContractHarness {
  readonly name: string;
  /** A marker the simulated provider echoes into error bodies. It must never reach an error. */
  readonly canary: string;
  /** Return undefined for a scenario the harness cannot simulate; those tests are skipped. */
  setup(scenario: ContractScenario): ContractFixture | undefined | Promise<ContractFixture | undefined>;
  /** A model id the connection does not offer. */
  readonly unknownModel?: string;
  /** How long a cancelled call may take to settle. Default 2000 ms. */
  readonly cancelWithinMs?: number;
}

const MARKER = "axis-contract-request-marker";

function request(model: string, extra: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    model,
    system: "You are a contract test.",
    messages: [{ role: "user", content: [{ type: "text", text: `hello ${MARKER}` }] }],
    maxOutputTokens: 256,
    ...extra,
  };
}

const TOOL = {
  name: "read_file",
  description: "Read a file in the workspace.",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

async function rejection(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    assert.ok(isProviderError(e), `expected a ProviderError, got ${e instanceof Error ? e.name : typeof e}`);
    return e;
  }
  assert.fail("expected the call to fail");
}

async function drain(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(handle));
}

async function settles(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return check();
}

function assertNoLeak(err: ProviderError, canary: string): void {
  for (const s of [err.message, String(err), JSON.stringify(err), err.stack ?? ""]) {
    assert.ok(!s.includes(canary), "error text contains the provider body canary");
    assert.ok(!s.includes(MARKER), "error text contains request content");
  }
  assert.equal(Object.prototype.hasOwnProperty.call(err, "cause"), false, "errors carry no cause chain");
}

function textOf(r: GenerateResult): string {
  return r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
}

function assertUsage(r: GenerateResult): void {
  for (const n of [r.usage.inputTokens, r.usage.outputTokens]) assert.ok(Number.isSafeInteger(n) && n >= 0);
}

/** Register the contract suite with `node:test` for one harness. */
export function runProviderContractSuite(harness: ContractHarness): void {
  const cancelMs = harness.cancelWithinMs ?? 2_000;
  const live = (): AbortSignal => new AbortController().signal;

  const fixture = async (t: TestContext, scenario: ContractScenario): Promise<ContractFixture | undefined> => {
    const f = await harness.setup(scenario);
    if (f === undefined) t.skip(`harness cannot simulate ${scenario.kind}`);
    return f;
  };

  describe(`provider contract: ${harness.name}`, () => {
    it("descriptor declares the API version, ids and a destination", async (t) => {
      const f = await fixture(t, { kind: "text", text: "hi" });
      if (f === undefined) return;
      const d = f.adapter.descriptor;
      assert.equal(d.apiVersion, PROVIDER_ADAPTER_API_VERSION);
      assert.match(d.providerId, /^[a-z][a-z0-9-]{0,63}$/);
      assert.ok(d.connectionId.length > 0);
      assert.ok(d.displayName.length > 0);
      assert.ok(d.destination.description.length > 0);
      if (d.destination.origin !== undefined) {
        const u = new URL(d.destination.origin);
        assert.equal(u.protocol, "https:", "provider origins are https");
        assert.equal(u.origin, d.destination.origin, "destination.origin is a bare origin");
      }
    });

    it("listModels returns unique ids including the fixture model", async (t) => {
      const f = await fixture(t, { kind: "text", text: "hi" });
      if (f === undefined) return;
      const models = await f.adapter.listModels({ signal: live() });
      const ids = models.map((m) => m.id);
      assert.ok(ids.includes(f.model));
      assert.equal(new Set(ids).size, ids.length);
    });

    it("getCapabilities returns a well-formed report for the model", async (t) => {
      const f = await fixture(t, { kind: "text", text: "hi" });
      if (f === undefined) return;
      const caps = await f.adapter.getCapabilities(f.model, { signal: live() });
      assert.equal(modelCapabilitiesSchema.safeParse(caps).success, true);
      assert.equal(caps.modelId, f.model);
      assert.equal(caps.features.streaming, "supported");
      assert.equal(caps.features.toolUse, "supported");
      assert.equal(caps.features.systemPrompt, "supported");
      assert.equal(caps.features.tokenCounting === "supported", f.adapter.countTokens !== undefined);
    });

    it("getCapabilities fails with not_found for an unknown model", async (t) => {
      const f = await fixture(t, { kind: "text", text: "hi" });
      if (f === undefined) return;
      const err = await rejection(f.adapter.getCapabilities(harness.unknownModel ?? "axis-contract-no-such-model", { signal: live() }));
      assert.equal(err.code, "not_found");
    });

    it("validateConnection reports a healthy connection", async (t) => {
      const f = await fixture(t, { kind: "text", text: "hi" });
      if (f === undefined) return;
      assert.deepEqual(await f.adapter.validateConnection({ signal: live() }), { ok: true });
    });

    it("validateConnection returns, not throws, a rejected credential", async (t) => {
      const f = await fixture(t, { kind: "error", code: "authentication" });
      if (f === undefined) return;
      const r = await f.adapter.validateConnection({ signal: live() });
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.ok(isProviderError(r.error));
        assert.equal(r.error.code, "authentication");
        assertNoLeak(r.error, harness.canary);
      }
    });

    it("stream: a text reply follows the event grammar", async (t) => {
      const f = await fixture(t, { kind: "text", text: "The quick brown fox jumps over the lazy dog." });
      if (f === undefined) return;
      const events = await drain(f.adapter.stream(request(f.model), { signal: live() }));
      const v = new StreamValidator();
      for (const ev of events) v.accept(ev);
      const r = v.result();
      assert.equal(textOf(r), "The quick brown fox jumps over the lazy dog.");
      assert.equal(r.stopReason, "end_turn");
      assert.equal(r.model.length > 0, true);
      assertUsage(r);
      assert.equal(f.requestCount(), 1);
      if (f.openStreams !== undefined) assert.equal(f.openStreams(), 0);
    });

    it("generate: returns what collectStream builds from stream", async (t) => {
      const scenario: ContractScenario = { kind: "text", text: "Same answer either way." };
      const a = await fixture(t, scenario);
      const b = await fixture(t, scenario);
      if (a === undefined || b === undefined) return;
      const gen = await a.adapter.generate(request(a.model), { signal: live() });
      const col = await collectStream(b.adapter.stream(request(b.model), { signal: live() }));
      assert.equal(textOf(gen), "Same answer either way.");
      assert.deepEqual(gen.content, col.content);
      assert.equal(gen.stopReason, col.stopReason);
      assertUsage(gen);
      assert.equal(a.requestCount(), 1);
    });

    for (const mode of ["stream", "generate"] as const) {
      it(`${mode}: a tool call carries its name and parsed input`, async (t) => {
        const input = { path: "src/index.ts" };
        const f = await fixture(t, { kind: "tool_use", name: TOOL.name, input });
        if (f === undefined) return;
        const req = request(f.model, { tools: [TOOL] });
        const r =
          mode === "stream"
            ? await collectStream(f.adapter.stream(req, { signal: live() }))
            : await f.adapter.generate(req, { signal: live() });
        assert.equal(r.stopReason, "tool_use");
        const calls = r.content.filter((b) => b.type === "tool_use");
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.name, TOOL.name);
        assert.deepEqual(calls[0]?.input, input);
        assert.ok((calls[0]?.id.length ?? 0) > 0);
      });
    }

    it("stream: reports max_tokens", async (t) => {
      const f = await fixture(t, { kind: "max_tokens", text: "cut off" });
      if (f === undefined) return;
      const r = await collectStream(f.adapter.stream(request(f.model), { signal: live() }));
      assert.equal(r.stopReason, "max_tokens");
    });

    for (const code of CONTRACT_ERROR_CODES) {
      for (const mode of ["stream", "generate"] as const) {
        it(`${mode}: a provider ${code} error maps to the taxonomy without leaking`, async (t) => {
          const scenario: ContractScenario = code === "rate_limited" ? { kind: "error", code, retryAfterMs: 3_000 } : { kind: "error", code };
          const f = await fixture(t, scenario);
          if (f === undefined) return;
          const req = request(f.model);
          const err = await rejection(
            mode === "stream" ? drain(f.adapter.stream(req, { signal: live() })) : f.adapter.generate(req, { signal: live() }),
          );
          assert.equal(err.code, code);
          assert.equal(err.retryable, isRetryableCode(code));
          if (code === "rate_limited") assert.equal(err.details.retryAfterMs, 3_000);
          assertNoLeak(err, harness.canary);
          assert.equal(f.requestCount(), 1, "adapters do not retry; the gateway decides (budget runs before each request)");
        });
      }
    }

    it("stream: an error after some output surfaces from iteration", async (t) => {
      const f = await fixture(t, { kind: "mid_stream_error", text: "partial" });
      if (f === undefined) return;
      const seen: StreamEvent[] = [];
      const err = await rejection(
        (async () => {
          for await (const ev of f.adapter.stream(request(f.model), { signal: live() })) seen.push(ev);
        })(),
      );
      assert.equal(err.code, "overloaded");
      assert.equal(seen[0]?.type, "message_start");
      const v = new StreamValidator();
      for (const ev of seen) v.accept(ev);
      assertNoLeak(err, harness.canary);
      if (f.openStreams !== undefined) assert.equal(f.openStreams(), 0);
    });

    for (const mode of ["stream", "generate"] as const) {
      it(`${mode}: a malformed response fails with invalid_response`, async (t) => {
        const f = await fixture(t, { kind: "malformed" });
        if (f === undefined) return;
        const req = request(f.model);
        const err = await rejection(
          mode === "stream" ? drain(f.adapter.stream(req, { signal: live() })) : f.adapter.generate(req, { signal: live() }),
        );
        assert.equal(err.code, "invalid_response");
        assertNoLeak(err, harness.canary);
      });

      it(`${mode}: an already aborted signal fails with cancelled and sends nothing`, async (t) => {
        const f = await fixture(t, { kind: "text", text: "never sent" });
        if (f === undefined) return;
        const c = new AbortController();
        c.abort();
        const req = request(f.model);
        const err = await rejection(
          mode === "stream" ? drain(f.adapter.stream(req, { signal: c.signal })) : f.adapter.generate(req, { signal: c.signal }),
        );
        assert.equal(err.code, "cancelled");
        assert.equal(f.requestCount(), 0);
      });

      it(`${mode}: an invalid request fails with invalid_request and sends nothing`, async (t) => {
        const f = await fixture(t, { kind: "text", text: "never sent" });
        if (f === undefined) return;
        for (const bad of [request(f.model, { messages: [] }), request(f.model, { maxOutputTokens: 0 })]) {
          const err = await rejection(
            mode === "stream" ? drain(f.adapter.stream(bad, { signal: live() })) : f.adapter.generate(bad, { signal: live() }),
          );
          assert.equal(err.code, "invalid_request");
        }
        assert.equal(f.requestCount(), 0);
      });

      it(`${mode}: a feature the model lacks is refused, not emulated`, async (t) => {
        const f = await fixture(t, { kind: "text", text: "never sent" });
        if (f === undefined) return;
        const caps = await f.adapter.getCapabilities(f.model, { signal: live() });
        const req = requestUsingMissingFeature(f.model, caps);
        if (req === undefined) {
          t.skip("the model supports every feature the suite can exercise");
          return;
        }
        const err = await rejection(
          mode === "stream" ? drain(f.adapter.stream(req, { signal: live() })) : f.adapter.generate(req, { signal: live() }),
        );
        assert.equal(err.code, "unsupported_capability");
        assert.equal(f.requestCount(), 0);
      });
    }

    it("stream: never throws synchronously", async (t) => {
      const f = await fixture(t, { kind: "text", text: "x" });
      if (f === undefined) return;
      assert.doesNotThrow(() => f.adapter.stream(request(f.model, { messages: [] }), { signal: live() }));
    });

    it("stream: aborting mid-response fails promptly with cancelled and releases the response", async (t) => {
      const f = await fixture(t, { kind: "hang" });
      if (f === undefined) return;
      const c = new AbortController();
      const iter = f.adapter.stream(request(f.model), { signal: c.signal })[Symbol.asyncIterator]();
      const first = await within(iter.next(), cancelMs, "first event");
      assert.equal(first.done, false);
      const pending = iter.next();
      c.abort();
      const err = await within(rejection(pending), cancelMs, "cancelled stream");
      assert.equal(err.code, "cancelled");
      if (f.openStreams !== undefined) assert.ok(await settles(() => f.openStreams?.() === 0, cancelMs), "response released");
    });

    it("generate: aborting mid-response fails promptly with cancelled", async (t) => {
      const f = await fixture(t, { kind: "hang" });
      if (f === undefined) return;
      const c = new AbortController();
      const p = f.adapter.generate(request(f.model), { signal: c.signal });
      await new Promise((r) => setTimeout(r, 10));
      c.abort();
      const err = await within(rejection(p), cancelMs, "cancelled generate");
      assert.equal(err.code, "cancelled");
      if (f.openStreams !== undefined) assert.ok(await settles(() => f.openStreams?.() === 0, cancelMs), "response released");
    });

    it("stream: ending iteration early releases the response", async (t) => {
      const f = await fixture(t, { kind: "text", text: "a long enough answer to need several deltas" });
      if (f === undefined) return;
      if (f.openStreams === undefined) {
        t.skip("harness does not report open responses");
        return;
      }
      for await (const ev of f.adapter.stream(request(f.model), { signal: live() })) {
        assert.equal(ev.type, "message_start");
        break;
      }
      assert.ok(await settles(() => f.openStreams?.() === 0, cancelMs), "response released");
    });

    it("countTokens and estimateCost, when present, return sane values", async (t) => {
      const f = await fixture(t, { kind: "text", text: "hi" });
      if (f === undefined) return;
      const a = f.adapter;
      if (a.countTokens !== undefined) {
        const n = await a.countTokens(request(f.model), { signal: live() });
        assert.ok(Number.isSafeInteger(n.inputTokens) && n.inputTokens > 0);
      }
      if (a.estimateCost !== undefined) {
        const usage = { inputTokens: 1_000, outputTokens: 500 };
        const c1 = a.estimateCost(f.model, usage);
        const c2 = a.estimateCost(f.model, usage);
        assert.deepEqual(c1, c2, "estimateCost is pure");
        if (c1 !== undefined) assert.ok(Number.isSafeInteger(c1.microUsd) && c1.microUsd >= 0);
        assert.equal(a.estimateCost(harness.unknownModel ?? "axis-contract-no-such-model", usage), undefined);
      }
    });
  });
}

/** A request that uses one feature the model does not report as supported, if the suite can build one. */
function requestUsingMissingFeature(model: string, caps: ModelCapabilities): GenerateRequest | undefined {
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
