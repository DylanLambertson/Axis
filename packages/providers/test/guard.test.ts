// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MOCK_DEFAULT_MODEL,
  ProviderError,
  REDACTED,
  createMockProvider,
  createRunBudget,
  createSecretRedactor,
  guardProvider,
  NO_SECRETS,
  estimateInputTokens,
  isProviderError,
  type BudgetUsageInfo,
  type GenerateRequest,
  type ProviderAdapter,
  type ProviderLogRecord,
  type StreamEvent,
} from "../src/index.js";

// A low-entropy stand-in for a stored credential: it must never look like a real key.
const SECRET = "canary-credential-value-for-tests";
const MARKER = "user-prompt-marker";

const live = (): AbortSignal => new AbortController().signal;

function req(extra: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    model: MOCK_DEFAULT_MODEL,
    messages: [{ role: "user", content: [{ type: "text", text: `please help ${MARKER}` }] }],
    maxOutputTokens: 1_000,
    ...extra,
  };
}

async function drain(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

async function fails(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    assert.ok(isProviderError(e));
    return e;
  }
  assert.fail("expected failure");
}

/** An adapter built on the mock with selected methods replaced. */
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

test("PRV-6: a run that reaches its token budget is stopped before the next provider request", async () => {
  const mock = createMockProvider({ replies: [{ kind: "text", text: "x".repeat(400) }] });
  const logs: ProviderLogRecord[] = [];
  const g = guardProvider(mock, { redactor: NO_SECRETS, log: (r) => logs.push(r) });
  const budget = createRunBudget({ maxTokens: 150 });
  const run = { runId: "run-1", signal: live(), budget };

  await drain(g.stream(req(), run));
  assert.equal(mock.requests.length, 1);
  assert.ok(budget.state().tokens <= 150, "the clamp keeps the run inside the cap");

  const err = await fails(drain(g.stream(req(), run)));
  assert.equal(err.code, "budget_exceeded");
  assert.equal(err.details.reason, "tokens");
  assert.equal(mock.requests.length, 1, "no second provider request");
  const refused = logs.find((l) => l.event === "request_refused");
  assert.equal(refused?.reason, "tokens", "the run records why");
});

test("PRV-6: maxOutputTokens is clamped to the remaining token headroom", async () => {
  const mock = createMockProvider();
  const g = guardProvider(mock, { redactor: NO_SECRETS });
  await g.generate(req({ maxOutputTokens: 1_000 }), { runId: "r", signal: live(), budget: createRunBudget({ maxTokens: 120 }) });
  const sent = mock.requests[0];
  assert.ok(sent !== undefined);
  // The headroom is the cap minus the (deliberately high) input estimate.
  assert.equal(sent.maxOutputTokens, 120 - estimateInputTokens(sent));
});

test("PRV-6: cost and request caps; an unpriceable model fails closed under a cost cap", async () => {
  const priced = createMockProvider();
  const g = guardProvider(priced, { redactor: NO_SECRETS });
  const budget = createRunBudget({ maxCostMicroUsd: 300 });
  let denied: ProviderError | undefined;
  for (let i = 0; i < 10 && denied === undefined; i++) {
    denied = await g.generate(req(), { runId: "r", signal: live(), budget }).then(() => undefined, (e: ProviderError) => e);
  }
  assert.equal(denied?.details.reason, "cost");
  assert.ok(priced.requests.length >= 1);
  assert.ok(budget.state().costMicroUsd <= 300, "the cost clamp keeps the run inside the cap");

  const unpriced = createMockProvider({ pricing: null });
  const e = await fails(guardProvider(unpriced, { redactor: NO_SECRETS }).generate(req(), { runId: "r", signal: live(), budget: createRunBudget({ maxCostMicroUsd: 1_000_000 }) }));
  assert.equal(e.details.reason, "cost_unknown");
  assert.equal(unpriced.requests.length, 0);

  const counted = createMockProvider();
  const rb = createRunBudget({ maxRequests: 1 });
  await guardProvider(counted, { redactor: NO_SECRETS }).generate(req(), { runId: "r", signal: live(), budget: rb });
  assert.equal((await fails(guardProvider(counted, { redactor: NO_SECRETS }).generate(req(), { runId: "r", signal: live(), budget: rb }))).details.reason, "requests");
  assert.equal(counted.requests.length, 1);
});

test("PRV-6: usage is recorded when a stream fails or the consumer stops early", async () => {
  const records: BudgetUsageInfo[] = [];
  const budget = {
    beforeRequest: () => ({ allow: true as const }),
    recordUsage: (i: BudgetUsageInfo) => void records.push(i),
  };
  const mock = createMockProvider({
    replies: [{ kind: "error", code: "overloaded", afterText: "partial" }, { kind: "text", text: "a long answer here" }],
  });
  const g = guardProvider(mock, { redactor: NO_SECRETS });
  await fails(drain(g.stream(req(), { runId: "r", signal: live(), budget })));
  for await (const _ of g.stream(req(), { runId: "r", signal: live(), budget })) break;
  assert.deepEqual(records.map((r) => r.outcome), ["failed", "cancelled"]);
  assert.ok((records[0]?.usage.inputTokens ?? 0) > 0, "billed input is counted on failure");
  assert.ok(records.every((r) => r.cost !== undefined));
  assert.equal(mock.openStreams, 0);
});

test("PRV-2: a request containing a stored credential is refused and never sent", async () => {
  const mock = createMockProvider();
  const logs: ProviderLogRecord[] = [];
  const g = guardProvider(mock, { redactor: createSecretRedactor({ secrets: () => [SECRET] }), log: (r) => logs.push(r) });
  for (const r of [
    req({ system: `key is ${SECRET}` }),
    req({ messages: [{ role: "user", content: [{ type: "text", text: `token=${encodeURIComponent(SECRET)}` }] }] }),
    req({ tools: [{ name: "t", description: "d", inputSchema: { default: SECRET } }] }),
    req({ providerOptions: { mock: { header: SECRET } } }),
  ]) {
    assert.equal((await fails(g.generate(r, { runId: "r", signal: live() }))).code, "secret_in_request");
  }
  assert.equal(mock.requests.length, 0);
  assert.ok(!JSON.stringify(logs).includes(SECRET));
});

test("PRV-2: error messages are redacted; foreign errors become a fixed internal error", async () => {
  const redactor = createSecretRedactor({ secrets: () => [SECRET] });
  const leaky = guardProvider(
    patched({ generate: async () => Promise.reject(new ProviderError("authentication", { message: `bad key ${SECRET}` })) }), { redactor },);
  const e1 = await fails(leaky.generate(req(), { runId: "r", signal: live() }));
  assert.equal(e1.code, "authentication");
  assert.equal(e1.message, `bad key ${REDACTED}`);

  const foreign = guardProvider(patched({ generate: async () => Promise.reject(new TypeError(`fetch failed ${SECRET}`)) }), { redactor });
  const e2 = await fails(foreign.generate(req(), { runId: "r", signal: live() }));
  assert.equal(e2.code, "internal");
  assert.ok(!JSON.stringify(e2).includes(SECRET) && !e2.message.includes("fetch"));

  const conn = guardProvider(
    patched({ validateConnection: async () => ({ ok: false, error: new ProviderError("authentication", { message: SECRET }) }) }), { redactor },);
  const r = await conn.validateConnection({ signal: live() });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.message, REDACTED);
});

test("DMN-6: logs carry metadata only, never request or response content", async () => {
  const logs: ProviderLogRecord[] = [];
  const g = guardProvider(createMockProvider(), { redactor: NO_SECRETS, log: (r) => logs.push(r) });
  await drain(g.stream(req(), { runId: "r", signal: live() }));
  const text = JSON.stringify(logs);
  assert.ok(!text.includes(MARKER), "prompt text is not logged");
  assert.ok(!text.includes("Mock reply"), "output text is not logged");
  assert.deepEqual(logs.map((l) => l.event), ["request_start", "request_end"]);
  assert.equal(logs[1]?.outcome, "completed");
  assert.equal(logs[0]?.destination, createMockProvider().descriptor.destination.description);
});

test("a throwing log sink does not change the outcome", async () => {
  const g = guardProvider(createMockProvider(), { redactor: NO_SECRETS, log: () => { throw new Error("sink down"); } });
  const r = await g.generate(req(), { runId: "r", signal: live() });
  assert.equal(r.stopReason, "end_turn");
});

test("capabilities: a feature the model lacks is refused by the guard before the adapter sees it", async () => {
  let called = 0;
  const g = guardProvider(patched({ generate: async () => { called++; throw new Error("unreachable"); } }), { redactor: NO_SECRETS });
  const e = await fails(
    g.generate(req({ messages: [{ role: "user", content: [{ type: "image", mediaType: "image/png", data: "AAAA" }] }] }), { runId: "r", signal: live() }),
  );
  assert.equal(e.code, "unsupported_capability");
  assert.equal(e.details.capability, "imageInput");
  assert.equal(called, 0);
});

test("timeouts: an idle stream is cut off with timeout/idle", async () => {
  const mock = createMockProvider({ replies: [{ kind: "hang", text: "thinking" }] });
  const g = guardProvider(mock, { redactor: NO_SECRETS, limits: { idleTimeoutMs: 30 } });
  const e = await fails(drain(g.stream(req(), { runId: "r", signal: live() })));
  assert.equal(e.code, "timeout");
  assert.equal(e.details.reason, "idle");
  assert.equal(mock.openStreams, 0);
});

test("timeouts: a whole request is cut off with timeout/request", async () => {
  const mock = createMockProvider({ replies: [{ kind: "hang" }] });
  const g = guardProvider(mock, { redactor: NO_SECRETS, limits: { requestTimeoutMs: 30 } });
  const e = await fails(g.generate(req(), { runId: "r", signal: live() }));
  assert.equal(e.code, "timeout");
  assert.equal(e.details.reason, "request");
});

test("cancellation is prompt even when the adapter ignores its signal", async () => {
  const never = new Promise<never>(() => undefined);
  let returned = false;
  const stubborn = patched({
    generate: () => never,
    stream: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => never,
        return: async () => {
          returned = true;
          return { done: true as const, value: undefined };
        },
      }),
    }),
  });
  const g = guardProvider(stubborn, { redactor: NO_SECRETS });

  const c1 = new AbortController();
  const p1 = g.generate(req(), { runId: "r", signal: c1.signal });
  setTimeout(() => c1.abort(), 5);
  assert.equal((await fails(p1)).code, "cancelled");

  const c2 = new AbortController();
  const p2 = drain(g.stream(req(), { runId: "r", signal: c2.signal }));
  setTimeout(() => c2.abort(), 5);
  assert.equal((await fails(p2)).code, "cancelled");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(returned, true, "the adapter iterator is asked to release");
});

test("an already aborted run sends nothing", async () => {
  const mock = createMockProvider();
  const c = new AbortController();
  c.abort();
  assert.equal((await fails(guardProvider(mock, { redactor: NO_SECRETS }).generate(req(), { runId: "r", signal: c.signal }))).code, "cancelled");
  assert.equal(mock.requests.length, 0);
});

test("a stream that breaks the grammar fails with invalid_response", async () => {
  const bad = patched({
    stream: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "message_start", model: MOCK_DEFAULT_MODEL } as StreamEvent;
        yield { type: "content_block_delta", index: 0, delta: { type: "text", text: "orphan" } } as StreamEvent;
      },
    }),
  });
  const e = await fails(drain(guardProvider(bad, { redactor: NO_SECRETS }).stream(req(), { runId: "r", signal: live() })));
  assert.equal(e.code, "invalid_response");
  assert.equal(e.details.reason, "delta_outside_block");

  const truncated = patched({
    stream: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "message_start", model: MOCK_DEFAULT_MODEL } as StreamEvent;
      },
    }),
  });
  assert.equal((await fails(drain(guardProvider(truncated, { redactor: NO_SECRETS }).stream(req(), { runId: "r", signal: live() })))).details.reason, "truncated_stream");
});

test("a malformed generate result fails with invalid_response", async () => {
  const bad = patched({
    generate: async () => ({ model: MOCK_DEFAULT_MODEL, content: [{ type: "tool_use", id: "t", name: "x", input: [1] }], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } }) as never,
  });
  const e = await fails(guardProvider(bad, { redactor: NO_SECRETS }).generate(req(), { runId: "r", signal: live() }));
  assert.equal(e.code, "invalid_response");
  assert.equal(e.details.reason, "tool_input_not_object");
});

test("stream limits: an oversized response is cut off", async () => {
  const mock = createMockProvider({ replies: [{ kind: "text", text: "y".repeat(100) }] });
  const e = await fails(drain(guardProvider(mock, { redactor: NO_SECRETS, limits: { maxTextChars: 10 } }).stream(req(), { runId: "r", signal: live() })));
  assert.equal(e.details.reason, "text_too_large");
  assert.equal(mock.openStreams, 0);
});

test("an adapter on another API version is refused", () => {
  const m = createMockProvider();
  assert.throws(() => guardProvider({ ...patched({}), descriptor: { ...m.descriptor, apiVersion: 2 } }, { redactor: NO_SECRETS }), RangeError);
});

test("countTokens without adapter support is unsupported_capability", async () => {
  const e = await fails(guardProvider(patched({}), { redactor: NO_SECRETS }).countTokens(req(), { runId: "r", signal: live() }));
  assert.equal(e.code, "unsupported_capability");
  const n = await guardProvider(createMockProvider(), { redactor: NO_SECRETS }).countTokens(req(), { runId: "r", signal: live() });
  assert.ok(n.inputTokens > 0);
});
