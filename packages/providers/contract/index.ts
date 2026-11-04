// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
/**
 * The provider adapter contract suite (`@axis/providers/contract`).
 *
 * Every adapter runs this suite against a harness that scripts its "wire":
 * the mock provider scripts replies directly; an HTTP adapter (ticket 9)
 * injects a fake transport that serves recorded responses and counts
 * requests. The suite needs no network.
 *
 * This entry point imports `node:test` and is test support only. It lives
 * outside `src/` so the ADR 0005 D3 staging hook, which copies
 * `packages/<name>/src/**`, never stages it into the Code OSS tree (N9).
 */
import { afterEach, beforeEach, describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { JsonValue } from "@axis/protocol";
import { inspect } from "node:util";
import { DETAIL_KEYS, ProviderError, isProviderError, isRetryableCode, type ProviderErrorCode } from "../src/errors.js";
import { StreamValidator, collectStream } from "../src/stream.js";
import {
  PROVIDER_ADAPTER_API_VERSION,
  modelCapabilitiesSchema,
  type GenerateRequest,
  type GenerateResult,
  type ModelCapabilities,
  type ProviderAdapter,
  type StreamEvent,
} from "../src/types.js";

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
   * An error response. The harness must put `canary` and `credential` into
   * the simulated response body and headers, to prove the adapter does not
   * echo them into errors (ANT-1).
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
  /** Responses still open on the wire. Required: release checks never skip (S9). */
  openStreams(): number;
  /**
   * The last request as the adapter put it on the wire, mapped back to these
   * fields (for an HTTP adapter: `model`, `max_tokens`, `system`,
   * `stop_sequences` from the body). Undefined before any request. The suite
   * checks that the adapter forwards them unchanged (NS1).
   */
  lastRequest(): ForwardedRequest | undefined;
}

/** The request fields an adapter must forward unchanged. */
export interface ForwardedRequest {
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly system?: string;
  readonly stopSequences?: readonly string[];
}

/** Every 12-character window of the credential, so a partial echo is caught too (NS5). */
export const CREDENTIAL_WINDOW = 12;

function needlesFor(canary: string, credential: string): string[] {
  const out = new Set<string>([canary, credential]);
  for (let i = 0; i + CREDENTIAL_WINDOW <= credential.length; i++) out.add(credential.slice(i, i + CREDENTIAL_WINDOW));
  return [...out];
}

/**
 * The adapter with every output recorded: events, results, listings,
 * reports and thrown values. `stream` still calls the adapter synchronously,
 * so the "never throws synchronously" check sees the adapter itself.
 */
function recording(a: ProviderAdapter, sink: unknown[]): ProviderAdapter {
  const keep = <T>(p: Promise<T>): Promise<T> =>
    p.then(
      (v) => {
        sink.push(v);
        return v;
      },
      (e: unknown) => {
        sink.push(e);
        throw e;
      },
    );
  const w: { -readonly [K in keyof ProviderAdapter]: ProviderAdapter[K] } = {
    descriptor: a.descriptor,
    listModels: (o) => keep(a.listModels(o)),
    getCapabilities: (m, o) => keep(a.getCapabilities(m, o)),
    validateConnection: (o) => keep(a.validateConnection(o)),
    generate: (r, o) => keep(a.generate(r, o)),
    stream: (r, o) => {
      const inner = a.stream(r, o);
      return {
        async *[Symbol.asyncIterator]() {
          try {
            for await (const ev of inner) {
              sink.push(ev);
              yield ev;
            }
          } catch (e) {
            sink.push(e);
            throw e;
          }
        },
      };
    },
  };
  const count = a.countTokens;
  if (count !== undefined) w.countTokens = (r, o) => keep(count.call(a, r, o));
  const cost = a.estimateCost;
  if (cost !== undefined) {
    w.estimateCost = (m, u) => {
      const c = cost.call(a, m, u);
      sink.push(c);
      return c;
    };
  }
  return w;
}

export interface ContractHarness {
  readonly name: string;
  /** A marker the simulated provider echoes into error bodies. It must never reach an error. */
  readonly canary: string;
  /**
   * The API credential the harness configures the adapter with (ANT-1). The
   * simulated provider echoes it into error bodies and headers; it must never
   * appear in an error, an event or a result, whole or as any 12-character
   * window (NS5). Use a low-entropy test value of at least 16 characters that
   * shares no 12-character run with the suite's own strings.
   */
  readonly credential: string;
  /** Every scenario must be simulated; a missing one fails the suite rather than skipping. */
  setup(scenario: ContractScenario): ContractFixture | Promise<ContractFixture>;
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

const ERROR_OWN_KEYS: ReadonlySet<string> = new Set(["stack", "message", "name", "code", "retryable", "details"]);
const DETAIL_KEY_SET: ReadonlySet<string> = new Set(DETAIL_KEYS);

/**
 * An error is exactly a ProviderError with its known fields, and nothing a
 * log sink would print contains a canary (S9). `util.inspect` with hidden
 * properties and getters is what common loggers see; `JSON.stringify` alone
 * goes through `toJSON` and would hide extra properties.
 */
function assertNoLeak(err: ProviderError, ...canaries: string[]): void {
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

  const needles = needlesFor(harness.canary, harness.credential);
  let outputs: unknown[] = [];

  const fixture = async (t: TestContext, scenario: ContractScenario): Promise<ContractFixture> => {
    void t;
    const f = await harness.setup(scenario);
    assert.ok(f !== undefined, `harness must simulate ${scenario.kind}`);
    return { ...f, adapter: recording(f.adapter, outputs), lastRequest: () => f.lastRequest(), requestCount: () => f.requestCount(), openStreams: () => f.openStreams() };
  };

  describe(`provider contract: ${harness.name}`, () => {
    beforeEach(() => {
      outputs = [];
    });

    // Every output of every scenario, events and results included, is free of
    // the provider body canary and of the credential, whole or in part (NS5).
    afterEach(() => {
      // Deltas are also checked joined: a credential split across chunks is
      // still a credential in what the consumer assembles.
      const joined = outputs
        .map((o) => {
          const ev = o as Partial<StreamEvent> & { delta?: { text?: unknown; partialJson?: unknown } };
          if (ev?.type !== "content_block_delta") return "";
          return typeof ev.delta?.text === "string" ? ev.delta.text : typeof ev.delta?.partialJson === "string" ? ev.delta.partialJson : "";
        })
        .join("");
      for (const n of needles) assert.ok(!joined.includes(n), "streamed output contains the credential or the provider body");
      for (const o of outputs) {
        const text = o instanceof Error || (typeof o === "object" && o !== null && !Array.isArray(o) && Object.getPrototypeOf(o) !== Object.prototype)
          ? inspect(o, { depth: Infinity, showHidden: true, getters: true })
          : JSON.stringify(o) ?? "";
        for (const n of needles) assert.ok(!text.includes(n), "an adapter output contains the credential or the provider body");
      }
    });

    it("descriptor declares the API version, ids and a destination", async (t) => {
      const f = await fixture(t, { kind: "text", text: "hi" });
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
      const models = await f.adapter.listModels({ signal: live() });
      const ids = models.map((m) => m.id);
      assert.ok(ids.includes(f.model));
      assert.equal(new Set(ids).size, ids.length);
    });

    it("getCapabilities returns a well-formed report for the model", async (t) => {
      const f = await fixture(t, { kind: "text", text: "hi" });
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
      const err = await rejection(f.adapter.getCapabilities(harness.unknownModel ?? "axis-contract-no-such-model", { signal: live() }));
      assert.equal(err.code, "not_found");
    });

    it("validateConnection reports a healthy connection", async (t) => {
      const f = await fixture(t, { kind: "text", text: "hi" });
      assert.deepEqual(await f.adapter.validateConnection({ signal: live() }), { ok: true });
    });

    it("validateConnection returns, not throws, a rejected credential", async (t) => {
      const f = await fixture(t, { kind: "error", code: "authentication" });
      const r = await f.adapter.validateConnection({ signal: live() });
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.ok(isProviderError(r.error));
        assert.equal(r.error.code, "authentication");
        assertNoLeak(r.error, ...needles);
      }
    });

    it("stream: a text reply follows the event grammar", async (t) => {
      const f = await fixture(t, { kind: "text", text: "The quick brown fox jumps over the lazy dog." });
      const events = await drain(f.adapter.stream(request(f.model), { signal: live() }));
      const v = new StreamValidator();
      for (const ev of events) v.accept(ev);
      const r = v.result();
      assert.equal(textOf(r), "The quick brown fox jumps over the lazy dog.");
      assert.equal(r.stopReason, "end_turn");
      assert.equal(r.model.length > 0, true);
      assertUsage(r);
      assert.equal(f.requestCount(), 1);
      assert.equal(f.openStreams(), 0);
      // Input usage right after message_start, so a cancelled request can be charged (S5).
      const second = events[1];
      assert.ok(second?.type === "usage" && second.usage.inputTokens > 0, "a usage event with input tokens follows message_start");
      assert.ok(!JSON.stringify(events).includes(harness.credential), "events never carry the credential");
    });

    it("generate: returns what collectStream builds from stream", async (t) => {
      const scenario: ContractScenario = { kind: "text", text: "Same answer either way." };
      const a = await fixture(t, scenario);
      const b = await fixture(t, scenario);
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
      const r = await collectStream(f.adapter.stream(request(f.model), { signal: live() }));
      assert.equal(r.stopReason, "max_tokens");
    });

    for (const code of CONTRACT_ERROR_CODES) {
      for (const mode of ["stream", "generate"] as const) {
        it(`${mode}: a provider ${code} error maps to the taxonomy without leaking`, async (t) => {
          const scenario: ContractScenario = code === "rate_limited" ? { kind: "error", code, retryAfterMs: 3_000 } : { kind: "error", code };
          const f = await fixture(t, scenario);
          const req = request(f.model);
          const err = await rejection(
            mode === "stream" ? drain(f.adapter.stream(req, { signal: live() })) : f.adapter.generate(req, { signal: live() }),
          );
          assert.equal(err.code, code);
          assert.equal(err.retryable, isRetryableCode(code));
          if (code === "rate_limited") assert.equal(err.details.retryAfterMs, 3_000);
          assertNoLeak(err, ...needles);
          assert.equal(f.requestCount(), 1, "adapters do not retry; the gateway decides (budget runs before each request)");
        });
      }
    }

    it("stream: an error after some output surfaces from iteration", async (t) => {
      const f = await fixture(t, { kind: "mid_stream_error", text: "partial" });
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
      assertNoLeak(err, ...needles);
      assert.equal(f.openStreams(), 0);
    });

    for (const mode of ["stream", "generate"] as const) {
      it(`${mode}: a malformed response fails with invalid_response`, async (t) => {
        const f = await fixture(t, { kind: "malformed" });
        const req = request(f.model);
        const err = await rejection(
          mode === "stream" ? drain(f.adapter.stream(req, { signal: live() })) : f.adapter.generate(req, { signal: live() }),
        );
        assert.equal(err.code, "invalid_response");
        assertNoLeak(err, ...needles);
      });

      it(`${mode}: an already aborted signal fails with cancelled and sends nothing`, async (t) => {
        const f = await fixture(t, { kind: "text", text: "never sent" });
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

    it("forwards model, maxOutputTokens, system and stopSequences unchanged", async (t) => {
      const f = await fixture(t, { kind: "text", text: "forwarded" });
      const caps = await f.adapter.getCapabilities(f.model, { signal: live() });
      const stop = caps.features.stopSequences === "supported" ? { stopSequences: ["END-OF-TURN"] } : {};
      const req = request(f.model, { maxOutputTokens: 321, ...stop });
      await f.adapter.generate(req, { signal: live() });
      const sent = f.lastRequest();
      assert.ok(sent !== undefined, "the harness reports the request it saw");
      assert.equal(sent.model, f.model);
      assert.equal(sent.maxOutputTokens, 321, "the output cap is forwarded exactly");
      assert.equal(sent.system, req.system);
      if ("stopSequences" in stop) assert.deepEqual(sent.stopSequences, stop.stopSequences);
    });

    it("providerOptions cannot redirect the request, add headers or change auth", async (t) => {
      const f = await fixture(t, { kind: "text", text: "never sent" });
      const own = f.adapter.descriptor.providerId;
      const hostile = request(f.model, {
        providerOptions: {
          [own]: { baseUrl: "https://attacker.invalid", origin: "https://attacker.invalid", headers: { authorization: "x" }, redirect: "follow" },
        },
      });
      const err = await rejection(f.adapter.generate(hostile, { signal: live() }));
      assert.equal(err.code, "invalid_request");
      assert.equal(f.requestCount(), 0);
    });

    it("providerOptions for another provider are ignored", async (t) => {
      const f = await fixture(t, { kind: "text", text: "fine" });
      const r = await f.adapter.generate(request(f.model, { providerOptions: { "some-other-provider": { anything: true } } }), { signal: live() });
      assert.equal(textOf(r), "fine");
      assert.ok(!JSON.stringify(r).includes(harness.credential));
    });

    it("stream: never throws synchronously", async (t) => {
      const f = await fixture(t, { kind: "text", text: "x" });
      assert.doesNotThrow(() => f.adapter.stream(request(f.model, { messages: [] }), { signal: live() }));
    });

    it("stream: aborting mid-response fails promptly with cancelled and releases the response", async (t) => {
      const f = await fixture(t, { kind: "hang" });
      const c = new AbortController();
      const iter = f.adapter.stream(request(f.model), { signal: c.signal })[Symbol.asyncIterator]();
      const first = await within(iter.next(), cancelMs, "first event");
      assert.equal(first.done, false);
      const pending = iter.next();
      c.abort();
      const err = await within(rejection(pending), cancelMs, "cancelled stream");
      assert.equal(err.code, "cancelled");
      assert.ok(await settles(() => f.openStreams() === 0, cancelMs), "response released");
    });

    it("generate: aborting mid-response fails promptly with cancelled", async (t) => {
      const f = await fixture(t, { kind: "hang" });
      const c = new AbortController();
      const p = f.adapter.generate(request(f.model), { signal: c.signal });
      await new Promise((r) => setTimeout(r, 10));
      c.abort();
      const err = await within(rejection(p), cancelMs, "cancelled generate");
      assert.equal(err.code, "cancelled");
      assert.ok(await settles(() => f.openStreams() === 0, cancelMs), "response released");
    });

    it("stream: ending iteration early releases the response", async (t) => {
      const f = await fixture(t, { kind: "text", text: "a long enough answer to need several deltas" });
      for await (const ev of f.adapter.stream(request(f.model), { signal: live() })) {
        assert.equal(ev.type, "message_start");
        break;
      }
      assert.ok(await settles(() => f.openStreams() === 0, cancelMs), "response released");
    });

    it("countTokens and estimateCost, when present, return sane values", async (t) => {
      const f = await fixture(t, { kind: "text", text: "hi" });
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
