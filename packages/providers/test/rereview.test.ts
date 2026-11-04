// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for the re-review of 80c5582 (NB = new blocker, NS = new
// should-fix, NN = new nit). Each test fails on 80c5582.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import {
  MOCK_DEFAULT_MODEL,
  ProviderError,
  createMockProvider,
  estimateInputTokens,
  validateRequest,
  createRunBudget,
  createSecretRedactor,
  guardProvider,
  isProviderError,
  type BudgetHook,
  type BudgetUsageInfo,
  type GenerateRequest,
  type ProviderAdapter,
  type ProviderLogRecord,
  type StreamEvent,
} from "../src/index.js";

// Low-entropy stand-in for a stored credential.
const SECRET = "canary-credential-value-for-tests";
const redactor = createSecretRedactor({ secrets: () => [SECRET] });
const live = (): AbortSignal => new AbortController().signal;
const run = () => ({ runId: "r", signal: live() });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function req(extra: Partial<GenerateRequest> = {}): GenerateRequest {
  return { model: MOCK_DEFAULT_MODEL, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], maxOutputTokens: 100, ...extra };
}

function patched(over: Partial<ProviderAdapter>, base = createMockProvider()): ProviderAdapter {
  return {
    descriptor: base.descriptor,
    listModels: (o) => base.listModels(o),
    getCapabilities: (model, o) => base.getCapabilities(model, o),
    validateConnection: (o) => base.validateConnection(o),
    generate: (r, o) => base.generate(r, o),
    stream: (r, o) => base.stream(r, o),
    estimateCost: (m, u) => base.estimateCost?.(m, u),
    ...over,
  };
}

async function fails(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    assert.ok(isProviderError(e), `not a ProviderError: ${inspect(e)}`);
    return e;
  }
  assert.fail("expected failure");
}

async function drain(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

function spyBudget(over: Partial<BudgetHook> = {}): BudgetHook & { calls: BudgetUsageInfo[] } {
  const calls: BudgetUsageInfo[] = [];
  return { calls, beforeRequest: () => ({ allow: true }), recordUsage: (i) => void calls.push(i), ...over };
}

test("NB1: a request changed while capabilities are fetched is sent as it was scanned", async () => {
  const mock = createMockProvider();
  const request = req();
  const messages = request.messages as Array<GenerateRequest["messages"][number]>;
  const g = guardProvider(
    patched({
      getCapabilities: async (model, o) => {
        // The daemon appends to and edits its conversation during the round trip.
        messages.push({ role: "user", content: [{ type: "text", text: `key ${SECRET}` }] });
        (messages[0]?.content[0] as { text: string }).text = `edited ${SECRET}`;
        await sleep(5);
        return mock.getCapabilities(model, o);
      },
    }, mock),
    { redactor },
  );
  await g.generate(request, run());
  assert.equal(mock.requests.length, 1);
  assert.ok(!JSON.stringify(mock.requests).includes(SECRET), "the key never reaches the adapter");
  assert.equal(mock.requests[0]?.messages.length, 1);
});

test("NB1: a Proxy that hides its fields from the scan is refused, not sent", async () => {
  const mock = createMockProvider();
  const hidden = new Proxy(req({ system: `key ${SECRET}` }), { ownKeys: () => [], getOwnPropertyDescriptor: () => undefined });
  const e = await fails(guardProvider(mock, { redactor }).generate(hidden, run()));
  assert.ok(e.code === "secret_in_request" || e.code === "invalid_request", e.code);
  assert.equal(mock.requests.length, 0);
});

test("NN1: a long but schema-valid transcript is not refused by a node cap", async () => {
  const messages: GenerateRequest["messages"] = [];
  for (let i = 0; i < 1_000; i++) {
    messages.push({ role: "user", content: [{ type: "text", text: `turn ${i}` }] });
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "read", input: { items: Array.from({ length: 250 }, (_, k) => k) } }] });
  }
  messages.push({ role: "user", content: [{ type: "text", text: "go on" }] });
  const g = guardProvider(createMockProvider({ models: [{ id: MOCK_DEFAULT_MODEL, contextWindowTokens: 10_000_000 }] }), { redactor });
  const r = await g.generate(req({ messages }), run());
  assert.equal(r.stopReason, "end_turn");
});

/** An error object whose prototype lookup throws a message holding the key. */
function hostileError(): unknown {
  return new Proxy({}, { getPrototypeOf() { throw new Error(`boom ${SECRET}`); } });
}

test("NS4: a hostile thrown object becomes internal, is logged, and releases its reservation", async () => {
  for (const mode of ["generate", "stream"] as const) {
    const logs: ProviderLogRecord[] = [];
    const budget = createRunBudget({ maxTokens: 10_000 });
    const g = guardProvider(
      patched({
        generate: async () => Promise.reject(hostileError()),
        stream: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => Promise.reject(hostileError()) }) }),
      }),
      { redactor, log: (r) => logs.push(r) },
    );
    const p = mode === "generate" ? g.generate(req(), { ...run(), budget }) : drain(g.stream(req(), { ...run(), budget }));
    const e = await fails(p);
    assert.equal(e.code, "internal", mode);
    assert.ok(!inspect(e, { showHidden: true }).includes(SECRET));
    assert.ok(logs.some((l) => l.event === "request_end"), `${mode}: request_end logged`);
    assert.equal(budget.reserved().requests, 0, `${mode}: reservation released`);
  }
  const conn = guardProvider(patched({ validateConnection: async () => ({ ok: false, error: hostileError() as ProviderError }) }), { redactor });
  const r = await conn.validateConnection({ signal: live() });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, "internal");
});

test("NS3: generate failing with server_error or overloaded is charged the input, so a token cap still stops the run", async () => {
  for (const code of ["server_error", "overloaded"] as const) {
    let sent = 0;
    const g = guardProvider(patched({ generate: async () => { sent++; throw new ProviderError(code); } }), { redactor });
    const budget = createRunBudget({ maxTokens: 1_000 });
    for (let i = 0; i < 50; i++) await g.generate(req({ messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(200) }] }] }), { ...run(), budget }).catch(() => undefined);
    assert.ok(sent < 50, `${code}: ${sent} requests sent`);
    assert.ok(budget.state().tokens > 0);
  }
});

test("NS3: an adapter that throws a guard-only code gets internal", async () => {
  for (const code of ["budget_exceeded", "secret_in_request", "cancelled"] as const) {
    const g = guardProvider(patched({ generate: async () => { throw new ProviderError(code); } }), { redactor });
    assert.equal((await fails(g.generate(req(), run()))).code, "internal", code);
  }
  const g = guardProvider(patched({ generate: async () => { throw new ProviderError("timeout"); } }), { redactor });
  assert.equal((await fails(g.generate(req(), run()))).code, "timeout", "adapters keep their own wire timeouts");
});

test("NN7: a request cancelled before it reaches the adapter is charged nothing", async () => {
  for (const mode of ["generate", "stream"] as const) {
    const c = new AbortController();
    let called = 0;
    const budget = spyBudget();
    const g = guardProvider(
      patched({
        generate: async () => { called++; throw new Error("unreachable"); },
        stream: () => { called++; throw new Error("unreachable"); },
      }),
      // request_start is logged between the pre-flight and the adapter call.
      { redactor, log: (r) => { if (r.event === "request_start") c.abort(); } },
    );
    const p = mode === "generate" ? g.generate(req(), { runId: "r", signal: c.signal, budget }) : drain(g.stream(req(), { runId: "r", signal: c.signal, budget }));
    assert.equal((await fails(p)).code, "cancelled");
    assert.equal(called, 0);
    assert.equal(budget.calls[0]?.charged, "none", mode);
  }
});

test("NN2: an over-long adapter message cannot leave a secret prefix behind", async () => {
  const long = "longsecretpart-".repeat(260);
  const key = "keymaterial-".repeat(9);
  const r2 = createSecretRedactor({ secrets: () => [long, key] });
  const message = [long, long, long, long].join(" ") + "x".repeat(16_384 - 60 - 15_603) + key + " tail";
  const g = guardProvider(patched({ generate: async () => { throw new ProviderError("server_error", { message }); } }), { redactor: r2 });
  const e = await fails(g.generate(req(), run()));
  assert.ok(!e.message.includes("keymaterial-keymaterial"), e.message.slice(0, 80));
});

test("NS1: output beyond the cap the guard set is refused and charged as reported", async () => {
  const over = { inputTokens: 5, outputTokens: 10_003 };
  for (const mode of ["generate", "stream"] as const) {
    const budget = createRunBudget({ maxTokens: 200 });
    let sent = 0;
    const g = guardProvider(
      patched({
        generate: async (r) => { sent++; return { model: r.model, content: [{ type: "text", text: "x" }], stopReason: "end_turn", usage: over }; },
        stream: (r) => ({
          async *[Symbol.asyncIterator]() {
            sent++;
            yield { type: "message_start", model: r.model } as StreamEvent;
            yield { type: "usage", usage: { inputTokens: 5, outputTokens: 0 } } as StreamEvent;
            yield { type: "message_stop", stopReason: "end_turn", usage: over } as StreamEvent;
          },
        }),
      }),
      { redactor },
    );
    const call = () => (mode === "generate" ? g.generate(req(), { ...run(), budget }) : drain(g.stream(req(), { ...run(), budget })));
    const e = await fails(call());
    assert.equal(e.details.reason, "output_over_cap", mode);
    assert.ok(budget.state().tokens >= 10_003, `${mode}: the reported output is charged`);
    assert.equal((await fails(call())).code, "budget_exceeded", `${mode}: the run stops`);
    assert.equal(sent, 1);
  }
});

test("NS1: the mock's output cap covers tool calls too", async () => {
  const mock = createMockProvider({ replies: [{ kind: "tool_use", name: "write", input: { text: "y".repeat(5_000) } }] });
  const r = await mock.generate(req({ maxOutputTokens: 10, tools: [{ name: "write", description: "d", inputSchema: { type: "object" } }] }), { signal: live() });
  assert.equal(r.stopReason, "max_tokens");
  assert.ok(r.usage.outputTokens <= 10);
});

test("NS2: one request cannot cost more than the cost headroom", async () => {
  const mock = createMockProvider({ respond: () => ({ kind: "text", text: "z".repeat(200_000) }) });
  const budget = createRunBudget({ maxCostMicroUsd: 1_000 });
  const g = guardProvider(mock, { redactor });
  await g.generate(req({ maxOutputTokens: 30_000 }), { ...run(), budget });
  assert.ok(budget.state().costMicroUsd <= 1_000, `cost ${budget.state().costMicroUsd}`);
  assert.ok((mock.requests[0]?.maxOutputTokens ?? 0) < 30_000, "the output cap was clamped to the cost headroom");
  const tiny = createRunBudget({ maxCostMicroUsd: 1_000 }, { costMicroUsd: 999 });
  assert.equal((await fails(g.generate(req(), { ...run(), budget: tiny }))).details.reason, "cost");
});

test("S4/NN3: after a failed budget write, every later request on that budget is refused unsent, in both paths", async () => {
  for (const mode of ["generate", "stream"] as const) {
    const mock = createMockProvider();
    const budget = spyBudget({ recordUsage: () => { throw new Error("journal down"); } });
    const g = guardProvider(mock, { redactor });
    const call = () => (mode === "generate" ? g.generate(req(), { ...run(), budget }) : drain(g.stream(req(), { ...run(), budget })));
    assert.equal((await fails(call())).details.reason, "budget_record_failed", mode);
    for (let i = 0; i < 4; i++) {
      const e = await fails(call());
      assert.equal(e.code, "budget_exceeded");
      assert.equal(e.details.reason, "state_invalid");
    }
    assert.equal(mock.requests.length, 1, `${mode}: only the first request was sent`);
  }
});

test("NN4: the input estimate counts non-ASCII text and tool overhead", () => {
  const text = (t: string) => validateRequest(req({ messages: [{ role: "user", content: [{ type: "text", text: t }] }] }));
  assert.ok(estimateInputTokens(text("漢".repeat(10_000))) >= 10_000, "CJK: at least one token per character");
  assert.ok(estimateInputTokens(text("😀".repeat(5_000))) >= 10_000, "emoji: at least two tokens each");
  const plain = estimateInputTokens(text("hello"));
  const withTool = estimateInputTokens(validateRequest(req({ tools: [{ name: "t", description: "", inputSchema: {} }] })));
  assert.ok(withTool - plain >= 512, "tool use carries the provider's tool prompt");
});

test("NN4: with a provider that counts more input than the estimate, overshoot stays within the difference", async () => {
  for (const factor of [1, 1.5]) {
    const mock = createMockProvider({ inputTokenFactor: factor, respond: () => ({ kind: "text", text: "w".repeat(2_000) }) });
    const budget = createRunBudget({ maxTokens: 2_000 });
    const g = guardProvider(mock, { redactor });
    for (let i = 0; i < 20; i++) await g.generate(req(), { ...run(), budget }).catch(() => undefined);
    const slack = mock.requests.reduce((n, r) => n + Math.ceil(estimateInputTokens(r) * factor) - estimateInputTokens(r), 0);
    assert.ok(budget.state().tokens <= 2_000 + slack, `factor ${factor}: ${budget.state().tokens} > ${2_000 + slack}`);
    if (factor === 1) assert.ok(budget.state().tokens <= 2_000, "an exact estimate never overshoots");
  }
});

test("N4: the redactor reports how many secrets are too short to protect", () => {
  const r = createSecretRedactor({ secrets: () => ["short", "", "long-enough-secret"] });
  assert.equal(r.skippedSecrets(), 1);
});
