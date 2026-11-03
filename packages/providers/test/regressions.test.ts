// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for the review of 847a298 (B = blocker, S = should-fix,
// N = nit). Each test fails on 847a298.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import {
  MOCK_DEFAULT_MODEL,
  NO_SECRETS,
  ProviderError,
  StreamValidator,
  DEFAULT_STREAM_LIMITS,
  createMockProvider,
  createRunBudget,
  createSecretRedactor,
  guardProvider,
  isProviderError,
  toAxisError,
  validateRequest,
  type BudgetHook,
  type BudgetUsageInfo,
  type GenerateRequest,
  type ProviderAdapter,
  type ProviderLogRecord,
  type StreamEvent,
} from "../src/index.js";

// Low-entropy stand-ins for stored credentials.
const SECRET = "canary-credential-value-for-tests";
const WORD_SECRET = "canary_credential_words";
const redactor = createSecretRedactor({ secrets: () => [SECRET, WORD_SECRET] });
const live = (): AbortSignal => new AbortController().signal;
const run = () => ({ runId: "r", signal: live() });

function req(extra: Partial<GenerateRequest> = {}): GenerateRequest {
  return { model: MOCK_DEFAULT_MODEL, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], maxOutputTokens: 100, ...extra };
}

function patched(over: Partial<ProviderAdapter>): ProviderAdapter {
  const m = createMockProvider();
  return {
    descriptor: m.descriptor,
    listModels: (o) => m.listModels(o),
    getCapabilities: (model, o) => m.getCapabilities(model, o),
    validateConnection: (o) => m.validateConnection(o),
    generate: (r, o) => m.generate(r, o),
    stream: (r, o) => m.stream(r, o),
    ...over,
  };
}

async function fails(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    assert.ok(isProviderError(e), `not a ProviderError: ${String(e)}`);
    return e;
  }
  assert.fail("expected failure");
}

function deepText(e: unknown): string {
  return inspect(e, { depth: Infinity, showHidden: true, getters: true });
}

/** A ProviderError-shaped object an adapter could forge without the constructor. */
function forged(props: Record<string, unknown>): ProviderError {
  const o = Object.create(ProviderError.prototype) as object;
  for (const [k, v] of Object.entries(props)) Object.defineProperty(o, k, { value: v, enumerable: true });
  return o as ProviderError;
}

test("B1: the guard never returns the adapter's error object", async () => {
  const original = forged({ code: "authentication", message: "bad credential", details: { status: 401, body: SECRET }, cause: { headers: { key: SECRET } }, body: SECRET });
  const g = guardProvider(patched({ generate: async () => Promise.reject(original) }), { redactor });
  const e = await fails(g.generate(req(), run()));
  assert.notEqual(e, original);
  assert.equal(e.code, "authentication");
  assert.equal(e.details.status, 401);
  assert.ok(!deepText(e).includes(SECRET), "no secret anywhere on the thrown object");
  assert.equal(Object.prototype.hasOwnProperty.call(e, "cause"), false);
  assert.ok(!JSON.stringify(toAxisError(e, "c")).includes(SECRET), "nothing extra reaches the bridge error");
});

test("B1: a message getter is read once and redacted", async () => {
  let reads = 0;
  const liar = Object.create(ProviderError.prototype, {
    code: { value: "server_error" },
    message: { get: () => { reads++; return `oops ${SECRET}`; } },
  }) as ProviderError;
  const g = guardProvider(patched({ generate: async () => Promise.reject(liar) }), { redactor });
  const e = await fails(g.generate(req(), run()));
  assert.equal(reads, 1);
  assert.ok(!deepText(e).includes(SECRET));
});

test("B1: reasons that carry data are dropped; unknown codes become internal", async () => {
  assert.equal(new ProviderError("invalid_request", { reason: "abc123def456" }).details.reason, undefined, "no digits in reasons");
  const g = guardProvider(patched({ generate: async () => Promise.reject(new ProviderError("invalid_request", { reason: WORD_SECRET })) }), { redactor });
  const e = await fails(g.generate(req(), run()));
  assert.equal(e.details.reason, undefined);
  const odd = guardProvider(patched({ generate: async () => Promise.reject(forged({ code: "made_up", message: "x" })) }), { redactor });
  assert.equal((await fails(odd.generate(req(), run()))).code, "internal");
});

test("B1: validateConnection errors are rebuilt too, and ok results are fresh", async () => {
  const bad = forged({ code: "authentication", message: "no", details: {}, body: SECRET });
  const g = guardProvider(patched({ validateConnection: async () => ({ ok: false, error: bad }) }), { redactor });
  const r = await g.validateConnection({ signal: live() });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.notEqual(r.error, bad);
    assert.ok(!deepText(r.error).includes(SECRET));
  }
  const ok = guardProvider(patched({ validateConnection: async () => ({ ok: true, extra: SECRET }) as never }), { redactor });
  assert.deepEqual(await ok.validateConnection({ signal: live() }), { ok: true });
});

test("B1: toAxisError copies only the four known detail keys", () => {
  const e = forged({ code: "rate_limited", message: "m", details: { retryAfterMs: 5, body: SECRET, reason: "tokens" } });
  const a = toAxisError(e, "c");
  assert.deepEqual(Object.keys(a.details ?? {}).sort(), ["providerCode", "reason", "retryAfterMs"]);
});

test("B1: ProviderError instances are frozen", () => {
  const e = new ProviderError("internal");
  assert.ok(Object.isFrozen(e));
  assert.throws(() => Object.assign(e, { body: SECRET }));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function drain(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/** The mock with `estimateCost` replaced. */
function pricedBy(estimateCost: NonNullable<ProviderAdapter["estimateCost"]>): { adapter: ProviderAdapter; sent: () => number } {
  const m = createMockProvider();
  const adapter = { ...patched({}), generate: (r: GenerateRequest, o: { signal: AbortSignal }) => m.generate(r, o), estimateCost };
  return { adapter, sent: () => m.requests.length };
}

test("B2: a cost cap fails closed on NaN, negative, throwing or partial cost estimates", async () => {
  const cases: Array<[string, NonNullable<ProviderAdapter["estimateCost"]>]> = [
    ["NaN", () => ({ microUsd: Number.NaN })],
    ["negative", () => ({ microUsd: -1e10 })],
    ["only priced at zero usage", (_m, u) => (u.inputTokens + u.outputTokens === 0 ? { microUsd: 0 } : undefined)],
    ["throws for real usage", (_m, u) => { if (u.inputTokens > 0) throw new Error("no price"); return { microUsd: 0 }; }],
    ["no cache-read price", (_m, u) => ({ microUsd: u.inputTokens + (u.cacheReadTokens === undefined ? 0 : Number.NaN) })],
  ];
  for (const [name, estimateCost] of cases) {
    const { adapter, sent } = pricedBy(estimateCost);
    const g = guardProvider(adapter, { redactor: NO_SECRETS });
    const budget = createRunBudget({ maxCostMicroUsd: 1_000 });
    for (let i = 0; i < 5; i++) await g.generate(req(), { ...run(), budget }).catch(() => undefined);
    assert.equal(sent(), 0, name);
  }
});

test("B2: a request whose actual cost cannot be priced stops later requests under a cost cap", async () => {
  // Priced for the probe and the worst case, unpriced for the small real usage.
  const { adapter, sent } = pricedBy((_m, u) => (u.outputTokens >= 100 ? { microUsd: 1 } : undefined));
  const g = guardProvider(adapter, { redactor: NO_SECRETS });
  const budget = createRunBudget({ maxCostMicroUsd: 1_000_000 });
  await g.generate(req(), { ...run(), budget });
  const e = await fails(g.generate(req(), { ...run(), budget }));
  assert.equal(e.details.reason, "cost_unknown");
  assert.equal(sent(), 1);
});

test("B2: fractional costs round up; corrupted journal state is refused", async () => {
  const { adapter } = pricedBy((_m, u) => ({ microUsd: (u.inputTokens + u.outputTokens) * 0.8 }));
  const budget = createRunBudget({ maxCostMicroUsd: 1_000_000 });
  await guardProvider(adapter, { redactor: NO_SECRETS }).generate(req(), { ...run(), budget });
  assert.ok(Number.isSafeInteger(budget.state().costMicroUsd) && budget.state().costMicroUsd > 0);
  assert.throws(() => createRunBudget({ maxTokens: 10 }, { tokens: Number.NaN }), RangeError);
  assert.throws(() => createRunBudget({ maxTokens: 10 }, { costMicroUsd: -1 }), RangeError);
});

test("B2: invalid usage poisons the budget", async () => {
  const b = createRunBudget({ maxTokens: 1_000 });
  const info = { requestId: "q1", runId: "r", providerId: "p", connectionId: "c", model: "m", maxOutputTokens: 10, estimatedInputTokens: 1, costKnown: true, worstCaseCost: undefined };
  assert.equal((await b.beforeRequest(info)).allow, true);
  await b.recordUsage({ ...info, usage: { inputTokens: Number.NaN, outputTokens: 0 }, charged: "reported", cost: undefined, outcome: "completed" });
  assert.deepEqual(await b.beforeRequest({ ...info, requestId: "q2" }), { allow: false, reason: "state_invalid" });
});

test("B3: countTokens runs the secret scan and the capability check, and logs", async () => {
  let counted = 0;
  const logs: ProviderLogRecord[] = [];
  const g = guardProvider(patched({ countTokens: async () => { counted++; return { inputTokens: 1 }; } }), { redactor, log: (r) => logs.push(r) });
  const e1 = await fails(g.countTokens(req({ system: `use ${SECRET}` }), run()));
  assert.equal(e1.code, "secret_in_request");
  const e2 = await fails(g.countTokens(req({ messages: [{ role: "user", content: [{ type: "image", mediaType: "image/png", data: "AAAA" }] }] }), run()));
  assert.equal(e2.code, "unsupported_capability");
  assert.equal(counted, 0);
  assert.deepEqual(logs.map((l) => [l.event, l.mode]), [["request_refused", "count_tokens"], ["request_refused", "count_tokens"]]);
  assert.equal((await g.countTokens(req(), run())).inputTokens, 1);

  const noCounting = createMockProvider({ models: [{ id: MOCK_DEFAULT_MODEL, features: { tokenCounting: "unsupported" } }] });
  assert.equal((await fails(guardProvider(noCounting, { redactor }).countTokens(req(), run()))).code, "unsupported_capability");
});

test("S1: the model id is checked and the raw request scanned before the adapter sees anything", async () => {
  let capabilityCalls = 0;
  const logs: ProviderLogRecord[] = [];
  const m = createMockProvider();
  const g = guardProvider(
    patched({ getCapabilities: (model, o) => { capabilityCalls++; return m.getCapabilities(model, o); } }),
    { redactor, log: (r) => logs.push(r) },
  );
  assert.equal((await fails(g.generate(req({ model: SECRET }), run()))).code, "secret_in_request");
  assert.equal((await fails(g.generate(req({ model: "has spaces" }), run()))).code, "invalid_request");
  assert.equal(capabilityCalls, 0);
  assert.ok(!JSON.stringify(logs).includes(SECRET));
  assert.ok(logs.every((l) => l.model === ""), "an unchecked model id is not logged");
});

test("S1: validation errors never echo a record key", async () => {
  const key = "keyprefixwords".repeat(6);
  const logs: ProviderLogRecord[] = [];
  const g = guardProvider(createMockProvider(), { redactor, log: (r) => logs.push(r) });
  const e = await fails(g.generate(req({ providerOptions: { [key]: 1 } }), run()));
  assert.equal(e.code, "invalid_request");
  assert.ok(!e.message.includes("keyprefix"), e.message);
  assert.ok(!JSON.stringify(logs).includes("keyprefix"));
  assert.throws(() => validateRequest(req({ providerOptions: { [key]: () => 1 } as never })), (x: unknown) => isProviderError(x) && !x.message.includes("keyprefix"));
});

test("S2: time the consumer spends on an event does not count as idle", async () => {
  const g = guardProvider(createMockProvider({ replies: [{ kind: "text", text: "a reply in a few deltas" }] }), { redactor, limits: { idleTimeoutMs: 50 } });
  let events = 0;
  for await (const _ of g.stream(req(), run())) {
    events++;
    await sleep(80);
  }
  assert.ok(events > 3);
});

/** An adapter whose stream has no `return()` and records whether its signal was aborted. */
function noReturnAdapter(events: unknown[]): { adapter: ProviderAdapter; aborted: () => boolean } {
  let signal: AbortSignal | undefined;
  const adapter = patched({
    stream: (_r, o) => {
      signal = o.signal;
      let i = 0;
      return { [Symbol.asyncIterator]: () => ({ next: async () => (i < events.length ? { done: false, value: events[i++] as StreamEvent } : new Promise<never>(() => undefined)) }) };
    },
  });
  return { adapter, aborted: () => signal?.aborted === true };
}

test("S3: early exit aborts the adapter's signal even without return()", async () => {
  const start = { type: "message_start", model: MOCK_DEFAULT_MODEL };
  const a = noReturnAdapter([start, { type: "usage", usage: { inputTokens: 1, outputTokens: 0 } }]);
  for await (const _ of guardProvider(a.adapter, { redactor }).stream(req(), run())) break;
  assert.equal(a.aborted(), true, "consumer break");

  const b = noReturnAdapter([start, { type: "bogus" }]);
  assert.equal((await fails(drain(guardProvider(b.adapter, { redactor }).stream(req(), run())))).code, "invalid_response");
  assert.equal(b.aborted(), true, "guard-side protocol error");
});

function spyBudget(opts: { throwOnRecord?: boolean } = {}): BudgetHook & { calls: BudgetUsageInfo[] } {
  const calls: BudgetUsageInfo[] = [];
  return {
    calls,
    beforeRequest: () => ({ allow: true }),
    recordUsage: (i) => {
      calls.push(i);
      if (opts.throwOnRecord === true) throw new Error("journal write failed at /var/lib/axis/journal.db");
    },
  };
}

test("S4: a failing budget write is recorded once and surfaces as internal", async () => {
  const b1 = spyBudget({ throwOnRecord: true });
  const e1 = await fails(guardProvider(createMockProvider(), { redactor }).generate(req(), { ...run(), budget: b1 }));
  assert.equal(e1.code, "internal");
  assert.equal(e1.details.reason, "budget_record_failed");
  assert.ok(!e1.message.includes("/var/lib"));
  assert.equal(b1.calls.length, 1);

  const b2 = spyBudget({ throwOnRecord: true });
  const logs: ProviderLogRecord[] = [];
  const e2 = await fails(drain(guardProvider(createMockProvider(), { redactor, log: (r) => logs.push(r) }).stream(req(), { ...run(), budget: b2 })));
  assert.equal(e2.code, "internal");
  assert.equal(b2.calls.length, 1);
  assert.ok(logs.some((l) => l.event === "request_end"), "the end record is still logged");
});

test("S5: usage is charged conservatively on timeout, cancel and abandonment; not for a refused request", async () => {
  const b1 = spyBudget();
  await fails(guardProvider(createMockProvider({ replies: [{ kind: "hang" }] }), { redactor, limits: { requestTimeoutMs: 30 } }).generate(req(), { ...run(), budget: b1 }));
  assert.equal(b1.calls[0]?.charged, "estimated");
  assert.equal(b1.calls[0]?.usage.outputTokens, 100, "the full output cap");
  assert.ok((b1.calls[0]?.usage.inputTokens ?? 0) > 0);

  const b2 = spyBudget();
  for await (const _ of guardProvider(createMockProvider({ replies: [{ kind: "text", text: "a long enough reply" }] }), { redactor }).stream(req(), { ...run(), budget: b2 })) break;
  assert.equal(b2.calls[0]?.charged, "estimated");
  assert.equal(b2.calls[0]?.outcome, "cancelled");
  assert.ok((b2.calls[0]?.usage.outputTokens ?? 0) >= 100);

  // Abandoned: one next(), then neither next() nor return(). The request timeout reaps it.
  const b3 = spyBudget();
  const mock = createMockProvider({ replies: [{ kind: "text", text: "a long enough reply" }] });
  const it = guardProvider(mock, { redactor, limits: { requestTimeoutMs: 40 } }).stream(req(), { ...run(), budget: b3 })[Symbol.asyncIterator]();
  await it.next();
  await sleep(120);
  assert.equal(b3.calls.length, 1, "recorded without the consumer");
  assert.equal(b3.calls[0]?.charged, "estimated");
  assert.equal(mock.openStreams, 0);

  const b4 = spyBudget();
  await fails(guardProvider(createMockProvider({ replies: [{ kind: "error", code: "authentication" }] }), { redactor }).generate(req(), { ...run(), budget: b4 }));
  assert.equal(b4.calls[0]?.charged, "none");
});

test("S6: concurrent requests in one run cannot overshoot the token cap", async () => {
  const mock = createMockProvider({ respond: () => ({ kind: "text", text: "x".repeat(400) }) });
  const budget = createRunBudget({ maxTokens: 150 });
  const g = guardProvider(mock, { redactor });
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => g.generate(req(), { ...run(), budget })));
  assert.ok(budget.state().tokens <= 150, `tokens ${budget.state().tokens}`);
  assert.ok(results.some((r) => r.status === "rejected"));
  assert.equal(budget.reserved().requests, 0, "every reservation is settled");
});

test("S7: limits must be positive safe integers; undefined keeps the default", () => {
  for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY, 1.5, 2 ** 31]) {
    assert.throws(() => guardProvider(createMockProvider(), { redactor, limits: { requestTimeoutMs: bad } }), RangeError, String(bad));
    assert.throws(() => guardProvider(createMockProvider(), { redactor, limits: { idleTimeoutMs: bad } }), RangeError, String(bad));
  }
  for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new StreamValidator({ maxTextChars: bad }), RangeError);
    assert.throws(() => guardProvider(createMockProvider(), { redactor, limits: { maxTextChars: bad } }), RangeError);
  }
  const v = new StreamValidator({ maxTextChars: undefined } as never);
  v.accept({ type: "message_start", model: "m" });
  v.accept({ type: "content_block_start", index: 0, block: { type: "text" } });
  assert.throws(() => v.accept({ type: "content_block_delta", index: 0, delta: { type: "text", text: "x".repeat(DEFAULT_STREAM_LIMITS.maxTextChars + 1) } }));
});

test("S8: tool input counts toward a per-response cap", () => {
  const v = new StreamValidator({ maxResponseChars: 20, maxToolInputChars: 15 });
  v.accept({ type: "message_start", model: "m" });
  const block = (index: number) => {
    v.accept({ type: "content_block_start", index, block: { type: "tool_use", id: `t${index}`, name: "x" } });
    v.accept({ type: "content_block_delta", index, delta: { type: "tool_input", partialJson: '{"a":"123456"}' } });
    v.accept({ type: "content_block_stop", index });
  };
  block(0);
  assert.throws(() => block(1), (e: unknown) => isProviderError(e) && e.details.reason === "response_too_large");
});

test("S10: the guard requires a redactor", () => {
  assert.throws(() => guardProvider(createMockProvider(), {} as never), TypeError);
});

test("N4: a sticky pattern still redacts every occurrence", () => {
  const r = createSecretRedactor({ secrets: () => [], patterns: [/demo-[a-z]{6}/y] });
  assert.equal(r.redact("a demo-abcdef b demo-ghijkl"), "a [REDACTED] b [REDACTED]");
});

test("N5: listModels and capabilities from the adapter are checked and copied", async () => {
  const g = guardProvider(patched({ listModels: async () => [{ id: "m1", extra: SECRET }] as never }), { redactor });
  assert.deepEqual(await g.listModels({ signal: live() }), [{ id: "m1" }]);
  const bad = guardProvider(patched({ listModels: async () => [{ id: "has space" }] }), { redactor });
  assert.equal((await fails(bad.listModels({ signal: live() }))).code, "invalid_response");
  const m = createMockProvider();
  const wrong = guardProvider(patched({ getCapabilities: async (_x, o) => m.getCapabilities(MOCK_DEFAULT_MODEL, o).then((c) => ({ ...c, modelId: "other" })) }), { redactor });
  assert.equal((await fails(wrong.getCapabilities(MOCK_DEFAULT_MODEL, { signal: live() }))).code, "invalid_response");
});

test("N6: duplicate tool ids, decreasing cache counters and missing tool input are refused", async () => {
  const v = new StreamValidator();
  v.accept({ type: "message_start", model: "m" });
  for (const index of [0, 1]) {
    const start = () => v.accept({ type: "content_block_start", index, block: { type: "tool_use", id: "same", name: "x" } });
    if (index === 0) {
      start();
      v.accept({ type: "content_block_stop", index });
    } else assert.throws(start, (e: unknown) => isProviderError(e) && e.details.reason === "duplicate_tool_use_id");
  }
  const w = new StreamValidator();
  w.accept({ type: "message_start", model: "m" });
  w.accept({ type: "usage", usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 10 } });
  assert.throws(() => w.accept({ type: "usage", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 5 } }));

  const g = guardProvider(patched({ generate: async () => ({ model: MOCK_DEFAULT_MODEL, content: [{ type: "tool_use", id: "t", name: "x" }], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } }) as never }), { redactor });
  assert.equal((await fails(g.generate(req(), run()))).details.reason, "tool_input_missing");
});

test("N8: several tool calls in one turn need parallelToolUse", () => {
  const two = req({
    messages: [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "x", input: {} }, { type: "tool_use", id: "b", name: "x", input: {} }] },
    ],
  });
  const caps = { modelId: MOCK_DEFAULT_MODEL, providerApiVersion: "v", limits: {}, features: { streaming: "supported", systemPrompt: "supported", toolUse: "supported", parallelToolUse: "unsupported", toolChoice: "supported", imageInput: "unsupported", stopSequences: "supported", temperature: "supported", structuredOutput: "unsupported", reasoning: "unsupported", promptCaching: "unsupported", tokenCounting: "supported", costEstimation: "supported" } } as const;
  assert.throws(() => validateRequest(two, caps), (e: unknown) => isProviderError(e) && e.details.capability === "parallelToolUse");
});
