// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for the third review's nits (R1, R5, R6, R7) on the guard
// and the mock. The contract-side nits are tested in contract-suite.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MOCK_DEFAULT_MODEL,
  ProviderError,
  createMockProvider,
  createSecretRedactor,
  estimateInputTokens,
  guardProvider,
  isProviderError,
  validateRequest,
  type BudgetRequestInfo,
  type GenerateRequest,
  type ProviderAdapter,
  type ProviderLogRecord,
} from "../src/index.js";

// Low-entropy stand-in for a stored credential.
const SECRET = "canary-credential-value-for-tests";
const redactor = createSecretRedactor({ secrets: () => [SECRET] });
const live = (): AbortSignal => new AbortController().signal;

function req(extra: Partial<GenerateRequest> = {}): GenerateRequest {
  return { model: MOCK_DEFAULT_MODEL, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], maxOutputTokens: 100, ...extra };
}

function withDescriptor(descriptor: object, base = createMockProvider()): ProviderAdapter {
  return {
    descriptor: descriptor as ProviderAdapter["descriptor"],
    listModels: (o) => base.listModels(o),
    getCapabilities: (m, o) => base.getCapabilities(m, o),
    validateConnection: (o) => base.validateConnection(o),
    generate: (r, o) => base.generate(r, o),
    stream: (r, o) => base.stream(r, o),
  };
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

test("R1: descriptor fields are redacted in every log line, and the descriptor is checked and frozen", async () => {
  const mock = createMockProvider();
  const leaky = { ...mock.descriptor, connectionId: `conn?api-key=${SECRET}`, destination: { description: `endpoint with ${SECRET}` } };
  const logs: ProviderLogRecord[] = [];
  const g = guardProvider(withDescriptor(leaky, mock), { redactor, log: (r) => logs.push(r) });
  await g.generate(req(), { runId: "r", signal: live() });
  await fails(g.generate(req({ model: "has space" }), { runId: "r", signal: live() }));
  assert.ok(logs.length >= 3);
  assert.ok(!JSON.stringify(logs).includes(SECRET), "no log line carries the credential");
  assert.ok(Object.isFrozen(g.descriptor) && Object.isFrozen(g.descriptor.destination));
  assert.notEqual(g.descriptor, leaky);

  for (const bad of [
    { ...mock.descriptor, providerId: "Has Spaces" },
    { ...mock.descriptor, destination: { origin: "http://plain.example.test", description: "d" } },
    { ...mock.descriptor, destination: { origin: "https://api.example.test/path", description: "d" } },
    { ...mock.descriptor, connectionId: "" },
  ]) {
    assert.throws(() => guardProvider(withDescriptor(bad, mock), { redactor }), TypeError);
  }
});

test("R5: the public getCapabilities checks and scans the model before the adapter sees it", async () => {
  let calls = 0;
  const mock = createMockProvider();
  const g = guardProvider({ ...withDescriptor(mock.descriptor, mock), getCapabilities: (m, o) => { calls++; return mock.getCapabilities(m, o); } }, { redactor });
  assert.equal((await fails(g.getCapabilities(SECRET, { signal: live() }))).code, "secret_in_request");
  assert.equal((await fails(g.getCapabilities("has space", { signal: live() }))).code, "invalid_request");
  assert.equal(calls, 0);
  assert.equal((await g.getCapabilities(MOCK_DEFAULT_MODEL, { signal: live() })).modelId, MOCK_DEFAULT_MODEL);
});

test("R6: cost reservations price the input at the higher cache-write rate", async () => {
  const mock = createMockProvider({ pricing: { inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 5, cacheWriteMicroUsdPerToken: 3 } });
  let seen: BudgetRequestInfo | undefined;
  const g = guardProvider(mock, { redactor });
  await g.generate(req(), {
    runId: "r",
    signal: live(),
    budget: { beforeRequest: (i) => { seen = i; return { allow: true }; }, recordUsage: () => undefined },
  });
  const est = estimateInputTokens(validateRequest(req()));
  assert.ok(seen !== undefined);
  assert.equal(seen.worstCaseCost?.microUsd, est * 3 + 100 * 5);
  assert.equal(seen.costForOutput?.(10), est * 3 + 10 * 5);
});

test("R7: the mock refuses an invalid inputTokenFactor", () => {
  for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createMockProvider({ inputTokenFactor: bad }), RangeError, String(bad));
  }
  assert.doesNotThrow(() => createMockProvider({ inputTokenFactor: 0 }));
});
