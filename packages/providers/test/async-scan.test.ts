// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MOCK_DEFAULT_MODEL,
  ProviderError,
  SCAN_BUDGET_CHARS,
  YIELD_CHARS,
  createMockProvider,
  defaultMessage,
  guardProvider,
  isProviderError,
  type BudgetHook,
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

test("an answer other than false is a secret: undefined, 1, a string, null, an object (review c7-f3-impl r1 N4)", async () => {
  for (const answer of [undefined, 1, 0, "no", null, {}]) {
    const mock = createMockProvider({ replies: [{ kind: "text", text: "ok" }] });
    const g = guardProvider(mock, { redactor: hook(async () => answer as unknown as boolean) });
    assert.equal((await fails(g.generate(req(), { runId: "r", signal: live() }))).code, "secret_in_request", String(answer));
    assert.equal(mock.requests.length, 0);
  }
});

test("a hook that never settles does not hold the request past a cancel: it ends cancelled, nothing sent (review c7-f3-impl r1 N1)", async () => {
  const mock = createMockProvider({ replies: [{ kind: "text", text: "ok" }] });
  const ac = new AbortController();
  const g = guardProvider(mock, { redactor: hook(() => (setImmediate(() => ac.abort()), new Promise<boolean>(() => undefined))) });
  // Bounded by loop turns, not time: the cancel lands on the first turn, so the request must have ended well before 50.
  const turns = async (n: number): Promise<string> => {
    for (let i = 0; i < n; i++) await new Promise<void>((res) => setImmediate(res));
    return "still pending";
  };
  const outcome = await Promise.race([g.generate(req(), { runId: "r", signal: ac.signal }).then(() => "sent", (e: unknown) => (isProviderError(e) ? e.code : "other")), turns(50)]);
  assert.equal(outcome, "cancelled");
  assert.equal(mock.requests.length, 0);
});

test("a secret set that changed during the scan makes the whole request scanned again; a second change is refused scan_budget", async () => {
  for (const [changes, outcome] of [[0, "sent"], [1, "sent"], [2, "scan_budget"]] as const) {
    const mock = createMockProvider({ replies: [{ kind: "text", text: "ok" }] });
    let version = 0;
    let scanned = 0;
    // The set changes once per pass while the prompt (one string of the request) is scanned, until `changes` is reached.
    const h = { ...hook(async (t) => (scanned++, t.includes(MARKER) && version < changes && version++, false)), secretsVersion: () => version };
    const g = guardProvider(mock, { redactor: h });
    const got = await g.generate(req(), { runId: "r", signal: live() }).then(() => "sent", (e: unknown) => (isProviderError(e) ? e.code : "other"));
    assert.equal(got, outcome, `${changes} changes`);
    const perPass = h.seen.length / Math.min(changes + 1, 2);
    assert.equal(scanned, Math.min(changes + 1, 2) * perPass, "every string of the request, once per pass");
    assert.equal(mock.requests.length, outcome === "sent" ? 1 : 0);
  }
});

test("the guard yields between strings: a request of many short strings lets the event loop turn every YIELD_CHARS characters", async () => {
  for (const mode of ["sync", "async"] as const) {
    let since = 0;
    let most = 0;
    let scanning = true;
    const tick = (): void => {
      since = 0;
      if (scanning) setImmediate(tick);
    };
    setImmediate(tick);
    const read = (t: string): boolean => {
      since += t.length;
      most = Math.max(most, since);
      return false;
    };
    const redactor: Redactor = mode === "sync" ? { redact: (t) => t, containsSecret: read } : { redact: (t) => t, containsSecret: () => false, containsSecretAsync: async (t) => read(t) };
    const mock = createMockProvider({ replies: [{ kind: "text", text: "ok" }] });
    const g = guardProvider(mock, { redactor });
    const r = req();
    const many: GenerateRequest = { ...r, messages: [{ role: "user", content: Array.from({ length: 200 }, (_, i) => ({ type: "text" as const, text: `${i} ${"word ".repeat(2_000)}` })) }] };
    await g.generate(many, { runId: "r", signal: live() });
    scanning = false;
    assert.equal(mock.requests.length, 1);
    assert.ok(most <= YIELD_CHARS + 10_100, `${mode}: ${most} characters in one loop turn`);
  }
});

/** A hook that finds MARKER only once `armed()`; its secrets version is `version.n`. */
function arming() {
  const version = { n: 0 };
  let armed = false;
  const h = { ...hook(async (t) => armed && t.includes(MARKER)), secretsVersion: () => version.n };
  const arm = (): void => {
    armed = true;
    version.n++;
  };
  return { h, arm };
}

test("a key registered after the scan, while capabilities or the run budget are awaited, is checked before the send (review c7-f3-impl r2)", async () => {
  for (const at of ["capabilities", "budget", "count_tokens"] as const) {
    const { h, arm } = arming();
    const m = createMockProvider({ replies: [{ kind: "text", text: "ok" }] });
    const adapter: ProviderAdapter = {
      descriptor: m.descriptor,
      listModels: (o) => m.listModels(o),
      getCapabilities: (model, o) => (at !== "budget" && arm(), m.getCapabilities(model, o)),
      validateConnection: (o) => m.validateConnection(o),
      generate: (r, o) => m.generate(r, o),
      stream: (r, o) => m.stream(r, o),
      countTokens: (r, o) => (m.countTokens as NonNullable<typeof m.countTokens>)(r, o),
    };
    const g = guardProvider(adapter, { redactor: h });
    const budget: BudgetHook = { beforeRequest: async () => (arm(), { allow: true }), recordUsage: () => undefined };
    const p = at === "count_tokens" ? g.countTokens(req(), { runId: "r", signal: live() }) : g.generate(req(), { runId: "r", signal: live(), ...(at === "budget" ? { budget } : {}) });
    assert.equal((await fails(p)).code, "secret_in_request", at);
    assert.equal(m.requests.length, 0, `${at}: nothing sent`);
  }
});

test("every pass of a request spends one budget: a restart that would read past what the first pass left is refused scan_budget (review c7-f3-impl r2 N2)", async () => {
  const mock = createMockProvider({ replies: [{ kind: "text", text: "ok" }] });
  let version = 0;
  const h = {
    ...hook(async (t, ctx) => {
      if (!t.includes(MARKER)) return false;
      const charge = Math.ceil(SCAN_BUDGET_CHARS * 0.6);
      if (ctx.budget.remaining < charge) throw new ProviderError("scan_budget");
      ctx.budget.remaining -= charge;
      if (version === 0) version++;
      return false;
    }),
    secretsVersion: () => version,
  };
  const g = guardProvider(mock, { redactor: h });
  assert.equal((await fails(g.generate(req(), { runId: "r", signal: live() }))).code, "scan_budget");
  assert.equal(mock.requests.length, 0);
});

test("a cancel at the guard's yield stops a synchronous scan: no string after it is read (review c7-f3-impl r2 N3)", async () => {
  let calls = 0;
  const ac = new AbortController();
  const redactor: Redactor = { redact: (t) => t, containsSecret: (t) => (t.length > 1_000 && calls++, false) };
  const mock = createMockProvider({ replies: [{ kind: "text", text: "ok" }] });
  const g = guardProvider(mock, { redactor });
  const strings = 200;
  const many: GenerateRequest = { ...req(), messages: [{ role: "user", content: Array.from({ length: strings }, (_, i) => ({ type: "text" as const, text: `${i} ${"word ".repeat(2_000)}` })) }] };
  setImmediate(() => ac.abort());
  assert.equal((await fails(g.generate(many, { runId: "r", signal: ac.signal }))).code, "cancelled");
  // The first yield comes after YIELD_CHARS (about 13 of these strings); none is read after the cancel it lets in.
  assert.ok(calls <= Math.ceil(YIELD_CHARS / 10_000) + 1, `${calls} long strings read`);
  assert.equal(mock.requests.length, 0);
});
