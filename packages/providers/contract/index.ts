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
  | { readonly kind: "malformed" }
  /**
   * The suite's transport answers every request (model listings, capability
   * lookups and message requests alike) with this redirect status and a
   * `Location` on `REDIRECT_HOST`, which the transport also answers, so an
   * adapter that follows gets a normal 200 back and no error to hide behind.
   * The adapter must not follow (ANT-1). The harness's own handler is not
   * called in this scenario.
   */
  | { readonly kind: "redirect"; readonly status: RedirectStatus };

export const REDIRECT_STATUSES = [301, 302, 303, 307, 308] as const;
export type RedirectStatus = (typeof REDIRECT_STATUSES)[number];

/** The recognizable host every redirect points at. It must never receive a request. */
export const REDIRECT_HOST = "redirect-target.contract.invalid";

/** The `fetch` options the suite's transport understands; Node's `fetch` takes the same. */
export interface ContractFetchInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  /** `fetch` follows redirects unless this is `manual` or `error`; the transport does the same. */
  readonly redirect?: "follow" | "manual" | "error";
  readonly signal?: AbortSignal;
}

/**
 * A `fetch`-shaped function. Generic over the init and response types, so an
 * adapter's own narrower `fetch` type (for example one that always passes
 * `redirect: "manual"` and returns a structural response) can be wrapped
 * without casts. What `wrap` returns answers with the inner function's
 * responses, or with a `Response` in the redirect scenario.
 */
export type ContractFetch<I extends ContractFetchInit = ContractFetchInit, R = Response> = (url: string, init: I) => Promise<R>;

/**
 * The suite's transport, handed to `ContractHarness.setup`. The harness must
 * build its adapter with `wrap(inner)` as the adapter's `fetch`, where `inner`
 * is the harness's fake server. The suite records every request at this seam
 * itself; nothing is taken from the adapter's own account (ANT-1).
 */
export interface ContractTransport {
  wrap<I extends ContractFetchInit, R>(inner: ContractFetch<I, R>): ContractFetch<I, R | Response>;
}

/** One request as the suite's transport saw it. */
export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /** The `redirect` option as given; `undefined` means `fetch`'s default, `follow`. */
  readonly redirect: string | undefined;
  /** Where the credential (or a transformed form of it) appeared. */
  readonly credentialIn: ReadonlyArray<"url" | "headers" | "body">;
}

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

/** Shortest test credential: shorter ones would get no 12-character windows (R4). */
export const MIN_CREDENTIAL_LENGTH = 16;
export const MIN_CANARY_LENGTH = 8;

/**
 * What the leak checks look for: the canary, the credential, every
 * 12-character window of it, and its common transformed forms, so an echo
 * through an `Authorization: Basic` header, a URL or a case change is caught
 * too (R3).
 */
export function needlesFor(canary: string, credential: string): string[] {
  const out = new Set<string>([canary, credential]);
  for (let i = 0; i + CREDENTIAL_WINDOW <= credential.length; i++) out.add(credential.slice(i, i + CREDENTIAL_WINDOW));
  const bytes = Buffer.from(credential, "utf8");
  out.add(bytes.toString("base64"));
  out.add(bytes.toString("base64").replace(/=+$/, ""));
  out.add(bytes.toString("base64url"));
  out.add(encodeURIComponent(credential));
  out.add(credential.toUpperCase());
  out.add(credential.toLowerCase());
  return [...out].filter((n) => n.length > 0);
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
  /**
   * Every scenario must be simulated; a missing one fails the suite rather
   * than skipping. An adapter with a network origin must be built with
   * `transport.wrap(inner)` as its `fetch`, in every scenario.
   */
  setup(scenario: ContractScenario, transport: ContractTransport): ContractFixture | Promise<ContractFixture>;
  /**
   * Required, with a reason, when the adapter has no network origin (the
   * mock): it makes no request, so the transport must record none. Must be
   * absent for an adapter with an origin.
   */
  readonly noNetwork?: string;
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
  // Refuse a harness whose leak checks would be weak or vacuous (R4).
  if (typeof harness.credential !== "string" || harness.credential.length < MIN_CREDENTIAL_LENGTH) {
    throw new RangeError(`the contract harness credential must be at least ${MIN_CREDENTIAL_LENGTH} characters`);
  }
  if (typeof harness.canary !== "string" || harness.canary.length < MIN_CANARY_LENGTH) {
    throw new RangeError(`the contract harness canary must be at least ${MIN_CANARY_LENGTH} characters`);
  }
  const cancelMs = harness.cancelWithinMs ?? 2_000;
  const live = (): AbortSignal => new AbortController().signal;

  const needles = needlesFor(harness.canary, harness.credential);
  let outputs: unknown[] = [];
  interface Tracked {
    readonly fixture: ContractFixture;
    readonly requests: RecordedRequest[];
  }
  let fixtures: Tracked[] = [];

  const credentialIn = (url: string, headers: Record<string, string>, body: string | undefined): Array<"url" | "headers" | "body"> => {
    const has = (text: string): boolean => needles.some((n) => text.includes(n));
    const out: Array<"url" | "headers" | "body"> = [];
    if (has(url)) out.push("url");
    if (has(JSON.stringify(headers))) out.push("headers");
    if (body !== undefined && has(body)) out.push("body");
    return out;
  };

  /** The suite-owned transport for one fixture: records every request, and plays the redirect scenario itself. */
  const transportFor = (scenario: ContractScenario, requests: RecordedRequest[]): ContractTransport => ({
    wrap<I extends ContractFetchInit, R>(inner: ContractFetch<I, R>): ContractFetch<I, R | Response> {
      const fetchFn: ContractFetch<I, R | Response> = async (url, init) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
        const body = init.body === undefined ? undefined : typeof init.body === "string" ? init.body : Buffer.from(init.body).toString("utf8");
        requests.push({
          url,
          method: (init.method ?? "GET").toUpperCase(),
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: init.redirect,
          credentialIn: credentialIn(url, headers, body),
        });
        if (scenario.kind !== "redirect") return inner(url, init);
        const target = new URL(url);
        if (target.host === REDIRECT_HOST) {
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        }
        const location = `https://${REDIRECT_HOST}${target.pathname}${target.search}`;
        const mode = init.redirect ?? "follow";
        // Real fetch semantics, so an adapter relying on the default is caught too.
        if (mode === "error") throw new TypeError("fetch failed: redirect mode is error");
        if (mode === "follow") return fetchFn(location, init);
        return new Response(null, { status: scenario.status, headers: { location } });
      };
      return fetchFn;
    },
  });

  const fixture = async (t: TestContext, scenario: ContractScenario): Promise<ContractFixture> => {
    void t;
    const requests: RecordedRequest[] = [];
    const f = await harness.setup(scenario, transportFor(scenario, requests));
    assert.ok(f !== undefined, `harness must simulate ${scenario.kind}`);
    const origin = f.adapter.descriptor.destination.origin;
    if (origin === undefined) {
      assert.ok(typeof harness.noNetwork === "string" && harness.noNetwork.length > 0, "an adapter without an origin needs a stated noNetwork reason");
    } else {
      assert.equal(harness.noNetwork, undefined, "an adapter with an origin cannot opt out of the transport checks");
    }
    const wrapped: ContractFixture = {
      ...f,
      adapter: recording(f.adapter, outputs),
      lastRequest: () => f.lastRequest(),
      requestCount: () => f.requestCount(),
      openStreams: () => f.openStreams(),
    };
    fixtures.push({ fixture: wrapped, requests });
    // The descriptor reaches every log line, so it is checked like an output (R1).
    outputs.push(f.adapter.descriptor);
    return wrapped;
  };

  /** Recorded requests that left the adapter's origin; for an adapter without one, every request. */
  const offOrigin = (tr: Tracked): RecordedRequest[] => {
    const origin = tr.fixture.adapter.descriptor.destination.origin;
    return tr.requests.filter((r) => {
      if (origin === undefined) return true;
      try {
        return new URL(r.url).origin !== origin;
      } catch {
        return true;
      }
    });
  };

  const trackedOf = (f: ContractFixture): Tracked => {
    const tr = fixtures.find((x) => x.fixture === f);
    assert.ok(tr !== undefined);
    return tr;
  };

  describe(`provider contract: ${harness.name}`, () => {
    beforeEach(() => {
      outputs = [];
      fixtures = [];
    });

    // In every scenario: every request the transport saw stayed on the
    // adapter's origin (none at all without one), and none asked fetch to
    // follow redirects, which it does by default (ANT-1).
    afterEach(() => {
      for (const tr of fixtures) {
        const off = offOrigin(tr);
        assert.deepEqual(off.map((r) => r.url.split("?")[0]), [], "a request left the adapter's origin");
        for (const r of tr.requests) {
          assert.ok(r.redirect === "manual" || r.redirect === "error", `a request did not set redirect to manual or error (${String(r.redirect)})`);
        }
      }
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
      const check = (sent: ForwardedRequest | undefined, mode: string): void => {
        assert.ok(sent !== undefined, `${mode}: the harness reports the request it saw`);
        assert.equal(sent.model, f.model);
        assert.equal(sent.maxOutputTokens, 321, `${mode}: the output cap is forwarded exactly`);
        assert.equal(sent.system, req.system);
        if ("stopSequences" in stop) assert.deepEqual(sent.stopSequences, stop.stopSequences);
      };
      await f.adapter.generate(req, { signal: live() });
      check(f.lastRequest(), "generate");
      // The stream path builds its request separately in most adapters (R2).
      const g = await fixture(t, { kind: "text", text: "forwarded" });
      await drain(g.adapter.stream(req, { signal: live() }));
      check(g.lastRequest(), "stream");
    });

    for (const status of REDIRECT_STATUSES) {
      for (const call of ["generate", "stream", "listModels", "getCapabilities", "validateConnection", "countTokens"] as const) {
        it(`${call}: a ${status} redirect is not followed, one request per call, all on the origin`, async (t) => {
          const f = await fixture(t, { kind: "redirect", status });
          const tr = trackedOf(f);
          const a = f.adapter;
          if (call === "countTokens" && a.countTokens === undefined) return; // The adapter has no such call path.

          // Run the call; record whether it failed and with what.
          let failed = false;
          let thrown: unknown;
          try {
            if (call === "generate") await a.generate(request(f.model), { signal: live() });
            else if (call === "stream") await drain(a.stream(request(f.model), { signal: live() }));
            else if (call === "listModels") await a.listModels({ signal: live() });
            else if (call === "getCapabilities") await a.getCapabilities(f.model, { signal: live() });
            else if (call === "countTokens") await (a.countTokens as NonNullable<ProviderAdapter["countTokens"]>)(request(f.model), { signal: live() });
            else {
              const r = await a.validateConnection({ signal: live() });
              if (!r.ok) {
                failed = true;
                thrown = r.error;
              }
            }
          } catch (e) {
            failed = true;
            thrown = e;
          }
          if (thrown !== undefined) {
            assert.ok(isProviderError(thrown), "failures are ProviderErrors");
            assertNoLeak(thrown, ...needles);
          }

          const origin = a.descriptor.destination.origin;
          if (origin === undefined) {
            assert.equal(tr.requests.length, 0, `no network (${harness.noNetwork ?? ""}): the transport saw no request`);
            return;
          }
          const sent = tr.requests;
          // Capabilities may be known locally; every other path is a network call.
          if (call === "getCapabilities" && sent.length === 0) return;
          assert.equal(sent.length, 1, `exactly one outbound request per call (saw ${sent.length})`);
          assert.ok(failed, "a redirected call fails; the error code is the adapter's own");
          assert.equal(sent.filter((r) => new URL(r.url).host === REDIRECT_HOST).length, 0, "no request reached the redirect host");
          for (const r of offOrigin(tr)) assert.deepEqual(r.credentialIn, [], "the credential left the adapter's origin");
          assert.equal(offOrigin(tr).length, 0, "every request went to the declared destination");
        });
      }
    }

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
