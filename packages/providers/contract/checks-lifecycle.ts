// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { it } from "node:test";
import { rejection, request, settles, textOf, within } from "./helpers.js";
import type { SuiteRuntime } from "./runtime.js";

export function registerLifecycleChecks(rt: SuiteRuntime): void {
  const { harness, live, cancelMs, fixture } = rt;
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
}
