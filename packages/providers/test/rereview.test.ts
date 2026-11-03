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
