// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ANTHROPIC_KEY_PATTERN, ANTHROPIC_ORIGIN, ANTHROPIC_VERSION, createAnthropicAdapter, type FetchLike } from "../src/index.js";
import { CREDENTIAL, PATTERN_KEY, failure, live, make, req, secretForms, views } from "./support/harness.js";
import { fakeFetch, sseResponse, textReply } from "./support/transport.js";

// Compile-time check: Node's global fetch satisfies the transport seam, so
// production wiring passes `fetch` as it is.
export const globalFetchFits: FetchLike = (url, init) => fetch(url, init);

const ok = (_c: unknown, counter: Parameters<Parameters<typeof make>[0]>[1]) => sseResponse(counter, textReply("ok"));

test("the key is asked for on every request, used as x-api-key, and nowhere else", async () => {
  let asked = 0;
  const { adapter, fake } = make(ok, { apiKey: () => (asked++, CREDENTIAL) });
  await adapter.generate(req(), { signal: live() });
  await adapter.generate(req(), { signal: live() });
  assert.equal(asked, 3, "model lookup and message for the first call, message only for the second (lookup is cached)");
  for (const c of fake.calls) {
    assert.deepEqual(Object.keys(c.init.headers).sort(), c.init.method === "POST" ? ["accept", "anthropic-version", "content-type", "x-api-key"] : ["accept", "anthropic-version", "x-api-key"]);
    assert.equal(c.init.headers["anthropic-version"], ANTHROPIC_VERSION);
    assert.equal(c.init.headers["x-api-key"], CREDENTIAL);
    assert.ok(c.url.startsWith(`${ANTHROPIC_ORIGIN}/`));
  }
});

test("an async key supplier works", async () => {
  const { adapter } = make(ok, { apiKey: async () => CREDENTIAL });
  assert.equal((await adapter.generate(req(), { signal: live() })).stopReason, "end_turn");
});

test("a key that could split a header is refused before anything is sent", async () => {
  for (const bad of ["has space inside it", "line\nbreak: injected", "cr\rkey-value-1234", "tab\tkey-value-1234", "short", "ünicode-key-value-1234", "x".repeat(4_097)]) {
    const { adapter, fake } = make(ok, { apiKey: () => bad });
    const err = await failure(adapter.generate(req(), { signal: live() }));
    assert.equal(err.code, "authentication");
    assert.equal(err.details.reason, "bad_key_format");
    assert.equal(fake.calls.length, 0, "not even the model lookup");
    for (const v of views(err)) assert.ok(!v.includes(bad.slice(0, 8)) || bad.length < 8);
  }
});

test("a missing or failing key supplier is no_credential and its text never surfaces", async () => {
  for (const apiKey of [() => "", () => undefined as never, () => { throw new Error(`vault says ${CREDENTIAL}`); }, async () => { throw new Error(`vault says ${CREDENTIAL}`); }]) {
    const { adapter, fake } = make(ok, { apiKey });
    const err = await failure(adapter.generate(req(), { signal: live() }));
    assert.equal(err.code, "authentication");
    assert.equal(err.details.reason, "no_credential");
    assert.equal(fake.calls.length, 0);
    for (const v of views(err)) for (const f of secretForms()) assert.ok(!v.includes(f));
  }
});

test("there is no way to change the origin: options have no base URL and requests cannot carry one", async () => {
  const f = fakeFetch((_c, counter) => sseResponse(counter, textReply("ok")));
  const adapter = createAnthropicAdapter({ connectionId: "c", apiKey: () => CREDENTIAL, fetch: f.fetch, baseUrl: "https://attacker.invalid" } as never);
  assert.equal(adapter.descriptor.destination.origin, ANTHROPIC_ORIGIN);
  const err = await failure(adapter.generate(req({ providerOptions: { anthropic: { baseUrl: "https://attacker.invalid", headers: { "x-api-key": "other-key-value" } } } }), { signal: live() }));
  assert.equal(err.code, "invalid_request");
  assert.equal(f.calls.length, 0);
  await adapter.listModels({ signal: live() }).catch(() => undefined);
  for (const c of f.calls) assert.ok(c.url.startsWith(`${ANTHROPIC_ORIGIN}/`));
});

test("the key pattern matches a provider-style key and not ordinary text", () => {
  assert.ok(ANTHROPIC_KEY_PATTERN.test(PATTERN_KEY));
  assert.ok(!ANTHROPIC_KEY_PATTERN.test("sk-learn is a package, and so is ant-design"));
});

test("a failing fetch maps to network with fixed text, whatever it throws", async () => {
  const { adapter } = make(ok, { fetch: async () => { throw new Error(`connect ECONNRESET ${CREDENTIAL}`); } });
  const err = await failure(adapter.getCapabilities("test-model", { signal: live() }));
  assert.equal(err.code, "network");
  assert.equal(err.retryable, true);
  for (const v of views(err)) assert.ok(!v.includes(CREDENTIAL));
});

test("an abort before or during the request is cancelled and sends nothing when early", async () => {
  const c = new AbortController();
  c.abort();
  const { adapter, fake } = make(ok);
  const err = await failure(adapter.generate(req(), { signal: c.signal }));
  assert.equal(err.code, "cancelled");
  assert.equal(fake.calls.length, 0);
});
