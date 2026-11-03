// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for the review of 847a298 (B = blocker, S = should-fix,
// N = nit). Each test fails on 847a298.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import {
  MOCK_DEFAULT_MODEL,
  ProviderError,
  createMockProvider,
  createSecretRedactor,
  guardProvider,
  isProviderError,
  toAxisError,
  type GenerateRequest,
  type ProviderAdapter,
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
