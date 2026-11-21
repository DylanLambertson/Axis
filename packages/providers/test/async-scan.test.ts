// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MOCK_DEFAULT_MODEL,
  ProviderError,
  SCAN_BUDGET_CHARS,
  createMockProvider,
  defaultMessage,
  guardProvider,
  isProviderError,
  type GenerateRequest,
  type ProviderAdapter,
  type Redactor,
  type ScanContext,
} from "../src/index.js";
import { GUARD_ONLY } from "../src/guard-billing.js";

// C7-F3: the guard's outgoing scan through a hook's asynchronous method (docs/design/composer-outgoing-scan.md).

const MARKER = "user-prompt-marker";
const live = (): AbortSignal => new AbortController().signal;
const req = (): GenerateRequest => ({
  model: MOCK_DEFAULT_MODEL,
  messages: [{ role: "user", content: [{ type: "text", text: `please help ${MARKER}` }] }],
  maxOutputTokens: 1_000,
});

async function fails(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    assert.ok(isProviderError(e));
    return e;
  }
  assert.fail("expected failure");
}

/** A hook whose synchronous scan must never be called; `scan` answers every string of a request. */
function hook(scan: (text: string, ctx: ScanContext) => Promise<boolean>): Redactor & { seen: Array<[string, ScanContext]> } {
  const seen: Array<[string, ScanContext]> = [];
  return {
    seen,
    redact: (t) => t,
    containsSecret: (t) => {
      // The model id stays on the synchronous path (it is one short string); nothing else may come here.
      if (t === MOCK_DEFAULT_MODEL) return false;
      throw new Error("the synchronous scan was used");
    },
    containsSecretAsync: (t, ctx) => {
      seen.push([t, ctx]);
      return scan(t, ctx);
    },
  };
}

test("the guard scans every string of a request through containsSecretAsync, with one shared ScanContext", async () => {
  const mock = createMockProvider({ replies: [{ kind: "text", text: "ok" }] });
  const h = hook(async () => false);
  const g = guardProvider(mock, { redactor: h });
  await g.generate(req(), { runId: "r", signal: live() });
  assert.equal(mock.requests.length, 1);
  assert.ok(h.seen.some(([t]) => t.includes(MARKER)), "the prompt was scanned");
  const ctx = h.seen[0]?.[1];
  assert.ok(h.seen.every(([, c]) => c === ctx), "one context for the whole request");
  assert.equal(ctx?.budget.remaining, SCAN_BUDGET_CHARS, "nothing charged by a hook that read nothing");
});

test("a secret found asynchronously refuses the request; nothing is sent", async () => {
  const mock = createMockProvider({ replies: [{ kind: "text", text: "ok" }] });
  const g = guardProvider(mock, { redactor: hook(async (t) => t.includes(MARKER)) });
  assert.equal((await fails(g.generate(req(), { runId: "r", signal: live() }))).code, "secret_in_request");
  assert.equal(mock.requests.length, 0);
});

test("the object scanned with is the snapshot: its asynchronous method is used, the live hook's is not", async () => {
  const mock = createMockProvider({ replies: [{ kind: "text", text: "ok" }] });
  const snap = hook(async (t) => t.includes(MARKER));
  const liveHook: Redactor = { ...hook(async () => false), snapshot: () => snap };
  const g = guardProvider(mock, { redactor: liveHook });
  assert.equal((await fails(g.generate(req(), { runId: "r", signal: live() }))).code, "secret_in_request");
  assert.ok(snap.seen.length > 0);
});

test("a budget stop is refused scan_budget, a fresh error with the fixed text: never secret_in_request, never clean", async () => {
  const mock = createMockProvider({ replies: [{ kind: "text", text: "ok" }] });
  // A hook-made object that passes `instanceof` and carries its own text and cause: only its code may come through.
  const thrown = Object.create(ProviderError.prototype, {
    code: { value: "scan_budget" },
    message: { value: `over by ${MARKER}` },
    cause: { value: MARKER },
  }) as ProviderError;
  const g = guardProvider(mock, { redactor: hook(async () => Promise.reject(thrown)) });
  const e = await fails(g.generate(req(), { runId: "r", signal: live() }));
  assert.equal(e.code, "scan_budget");
  assert.notEqual(e, thrown, "built fresh, never the hook's object");
  assert.equal(e.message, defaultMessage("scan_budget"));
  assert.equal("cause" in e, false);
  assert.ok(!JSON.stringify({ ...e, m: e.message }).includes(MARKER));
  assert.equal(mock.requests.length, 0);
});

test("a hook's own cancel keeps its code; any other rejection fails closed as secret_in_request", async () => {
  for (const [thrown, code] of [
    [new ProviderError("cancelled"), "cancelled"],
    [new Error("boom"), "secret_in_request"],
    [new ProviderError("internal"), "secret_in_request"],
    ["not an error", "secret_in_request"],
  ] as const) {
    const mock = createMockProvider({ replies: [{ kind: "text", text: "ok" }] });
    const g = guardProvider(mock, { redactor: hook(async () => Promise.reject(thrown)) });
    assert.equal((await fails(g.generate(req(), { runId: "r", signal: live() }))).code, code, String(thrown));
    assert.equal(mock.requests.length, 0);
  }
});

test("an abort during the scan ends cancelled: whatever the hook threw, and also when it answered clean", async () => {
  for (const answer of ["throw", "clean"] as const) {
    const mock = createMockProvider({ replies: [{ kind: "text", text: "ok" }] });
    const ac = new AbortController();
    const g = guardProvider(mock, {
      redactor: hook(async () => {
        ac.abort();
        if (answer === "throw") throw new Error("unrelated");
        return false;
      }),
    });
    assert.equal((await fails(g.generate(req(), { runId: "r", signal: ac.signal }))).code, "cancelled", answer);
    assert.equal(mock.requests.length, 0);
  }
});

test("count_tokens goes through the same scan (review c7-f3-design r2 N3)", async () => {
  const mock = createMockProvider({ replies: [] });
  const g = guardProvider(mock, { redactor: hook(async (t) => t.includes(MARKER)) });
  assert.equal((await fails(g.countTokens(req(), { runId: "r", signal: live() }))).code, "secret_in_request");
  const budget = guardProvider(createMockProvider({ replies: [] }), { redactor: hook(async () => Promise.reject(new ProviderError("scan_budget"))) });
  assert.equal((await fails(budget.countTokens(req(), { runId: "r", signal: live() }))).code, "scan_budget");
});

test("scan_budget is guard-only: an adapter that raises it gets internal", async () => {
  assert.ok(GUARD_ONLY.has("scan_budget"));
  const m = createMockProvider();
  const adapter: ProviderAdapter = {
    descriptor: m.descriptor,
    listModels: (o) => m.listModels(o),
    getCapabilities: (model, o) => m.getCapabilities(model, o),
    validateConnection: (o) => m.validateConnection(o),
    generate: () => Promise.reject(new ProviderError("scan_budget")),
    stream: (r, o) => m.stream(r, o),
  };
  const g = guardProvider(adapter, { redactor: hook(async () => false) });
  assert.equal((await fails(g.generate(req(), { runId: "r", signal: live() }))).code, "internal");
});
