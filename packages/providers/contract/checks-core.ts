// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { isRetryableCode, isProviderError } from "../src/errors.js";
import { StreamValidator, collectStream } from "../src/stream.js";
import { PROVIDER_ADAPTER_API_VERSION, modelCapabilitiesSchema, type StreamEvent } from "../src/types.js";
import { TOOL, assertNoLeak, assertUsage, drain, rejection, request, requestUsingMissingFeature, textOf } from "./helpers.js";
import type { SuiteRuntime } from "./runtime.js";
import { CONTRACT_ERROR_CODES, type ContractScenario, type ForwardedRequest } from "./types.js";
import { it } from "node:test";

export function registerCoreChecks(rt: SuiteRuntime): void {
  const { harness, needles, live, fixture } = rt;
  it("descriptor declares the API version, ids and a destination", async (t) => {
    const f = await fixture(t, { kind: "text", text: "hi" });
    const d = f.adapter.descriptor;
    assert.equal(d.apiVersion, PROVIDER_ADAPTER_API_VERSION);
    assert.match(d.providerId, /^[a-z][a-z0-9-]{0,63}$/);
    assert.ok(d.connectionId.length > 0);
    assert.ok(d.displayName.length > 0);
    assert.ok(d.destination.description.length > 0);
    if (d.destination.origin !== undefined) {
      const u = new URL(d.destination.origin);
      assert.equal(u.protocol, "https:", "provider origins are https");
      assert.equal(u.origin, d.destination.origin, "destination.origin is a bare origin");
    }
  });

  it("listModels returns unique ids including the fixture model", async (t) => {
    const f = await fixture(t, { kind: "text", text: "hi" });
    const models = await f.adapter.listModels({ signal: live() });
    const ids = models.map((m) => m.id);
    assert.ok(ids.includes(f.model));
    assert.equal(new Set(ids).size, ids.length);
  });

  it("getCapabilities returns a well-formed report for the model", async (t) => {
    const f = await fixture(t, { kind: "text", text: "hi" });
    const caps = await f.adapter.getCapabilities(f.model, { signal: live() });
    assert.equal(modelCapabilitiesSchema.safeParse(caps).success, true);
    assert.equal(caps.modelId, f.model);
    assert.equal(caps.features.streaming, "supported");
    assert.equal(caps.features.toolUse, "supported");
    assert.equal(caps.features.systemPrompt, "supported");
    assert.equal(caps.features.tokenCounting === "supported", f.adapter.countTokens !== undefined);
  });

  it("getCapabilities fails with not_found for an unknown model", async (t) => {
    const f = await fixture(t, { kind: "text", text: "hi" });
    const err = await rejection(f.adapter.getCapabilities(harness.unknownModel ?? "axis-contract-no-such-model", { signal: live() }));
    assert.equal(err.code, "not_found");
  });

  it("validateConnection reports a healthy connection", async (t) => {
    const f = await fixture(t, { kind: "text", text: "hi" });
    assert.deepEqual(await f.adapter.validateConnection({ signal: live() }), { ok: true });
  });

  it("validateConnection returns, not throws, a rejected credential", async (t) => {
    const f = await fixture(t, { kind: "error", code: "authentication" });
    const r = await f.adapter.validateConnection({ signal: live() });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(isProviderError(r.error));
      assert.equal(r.error.code, "authentication");
      assertNoLeak(r.error, ...needles);
    }
  });

  it("stream: a text reply follows the event grammar", async (t) => {
    const f = await fixture(t, { kind: "text", text: "The quick brown fox jumps over the lazy dog." });
    const events = await drain(f.adapter.stream(request(f.model), { signal: live() }));
    const v = new StreamValidator();
    for (const ev of events) v.accept(ev);
    const r = v.result();
    assert.equal(textOf(r), "The quick brown fox jumps over the lazy dog.");
    assert.equal(r.stopReason, "end_turn");
    assert.equal(r.model.length > 0, true);
    assertUsage(r);
    assert.equal(f.requestCount(), 1);
    assert.equal(f.openStreams(), 0);
    // Input usage right after message_start, so a cancelled request can be charged (S5).
    const second = events[1];
    assert.ok(second?.type === "usage" && second.usage.inputTokens > 0, "a usage event with input tokens follows message_start");
    assert.ok(!JSON.stringify(events).includes(harness.credential), "events never carry the credential");
  });

  it("generate: returns what collectStream builds from stream", async (t) => {
    const scenario: ContractScenario = { kind: "text", text: "Same answer either way." };
    const a = await fixture(t, scenario);
    const b = await fixture(t, scenario);
    const gen = await a.adapter.generate(request(a.model), { signal: live() });
    const col = await collectStream(b.adapter.stream(request(b.model), { signal: live() }));
    assert.equal(textOf(gen), "Same answer either way.");
    assert.deepEqual(gen.content, col.content);
    assert.equal(gen.stopReason, col.stopReason);
    assertUsage(gen);
    assert.equal(a.requestCount(), 1);
  });

  for (const mode of ["stream", "generate"] as const) {
    it(`${mode}: a tool call carries its name and parsed input`, async (t) => {
      const input = { path: "src/index.ts" };
      const f = await fixture(t, { kind: "tool_use", name: TOOL.name, input });
      const req = request(f.model, { tools: [TOOL] });
      const r =
        mode === "stream"
          ? await collectStream(f.adapter.stream(req, { signal: live() }))
          : await f.adapter.generate(req, { signal: live() });
      assert.equal(r.stopReason, "tool_use");
      const calls = r.content.filter((b) => b.type === "tool_use");
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.name, TOOL.name);
      assert.deepEqual(calls[0]?.input, input);
      assert.ok((calls[0]?.id.length ?? 0) > 0);
    });
  }

  it("stream: reports max_tokens", async (t) => {
    const f = await fixture(t, { kind: "max_tokens", text: "cut off" });
    const r = await collectStream(f.adapter.stream(request(f.model), { signal: live() }));
    assert.equal(r.stopReason, "max_tokens");
  });

  for (const code of CONTRACT_ERROR_CODES) {
    for (const mode of ["stream", "generate"] as const) {
      it(`${mode}: a provider ${code} error maps to the taxonomy without leaking`, async (t) => {
        const scenario: ContractScenario = code === "rate_limited" ? { kind: "error", code, retryAfterMs: 3_000 } : { kind: "error", code };
        const f = await fixture(t, scenario);
        const req = request(f.model);
        const err = await rejection(
          mode === "stream" ? drain(f.adapter.stream(req, { signal: live() })) : f.adapter.generate(req, { signal: live() }),
        );
        assert.equal(err.code, code);
        assert.equal(err.retryable, isRetryableCode(code));
        if (code === "rate_limited") assert.equal(err.details.retryAfterMs, 3_000);
        assertNoLeak(err, ...needles);
        assert.equal(f.requestCount(), 1, "adapters do not retry; the gateway decides (budget runs before each request)");
      });
    }
  }

  it("stream: an error after some output surfaces from iteration", async (t) => {
    const f = await fixture(t, { kind: "mid_stream_error", text: "partial" });
    const seen: StreamEvent[] = [];
    const err = await rejection(
      (async () => {
        for await (const ev of f.adapter.stream(request(f.model), { signal: live() })) seen.push(ev);
      })(),
    );
    assert.equal(err.code, "overloaded");
    assert.equal(seen[0]?.type, "message_start");
    const v = new StreamValidator();
    for (const ev of seen) v.accept(ev);
    assertNoLeak(err, ...needles);
    assert.equal(f.openStreams(), 0);
  });

  for (const mode of ["stream", "generate"] as const) {
    it(`${mode}: a malformed response fails with invalid_response`, async (t) => {
      const f = await fixture(t, { kind: "malformed" });
      const req = request(f.model);
      const err = await rejection(
        mode === "stream" ? drain(f.adapter.stream(req, { signal: live() })) : f.adapter.generate(req, { signal: live() }),
      );
      assert.equal(err.code, "invalid_response");
      assertNoLeak(err, ...needles);
    });

    it(`${mode}: an already aborted signal fails with cancelled and sends nothing`, async (t) => {
      const f = await fixture(t, { kind: "text", text: "never sent" });
      const c = new AbortController();
      c.abort();
      const req = request(f.model);
      const err = await rejection(
        mode === "stream" ? drain(f.adapter.stream(req, { signal: c.signal })) : f.adapter.generate(req, { signal: c.signal }),
      );
      assert.equal(err.code, "cancelled");
      assert.equal(f.requestCount(), 0);
    });

    it(`${mode}: an invalid request fails with invalid_request and sends nothing`, async (t) => {
      const f = await fixture(t, { kind: "text", text: "never sent" });
      for (const bad of [request(f.model, { messages: [] }), request(f.model, { maxOutputTokens: 0 })]) {
        const err = await rejection(
          mode === "stream" ? drain(f.adapter.stream(bad, { signal: live() })) : f.adapter.generate(bad, { signal: live() }),
        );
        assert.equal(err.code, "invalid_request");
      }
      assert.equal(f.requestCount(), 0);
    });

    it(`${mode}: a feature the model lacks is refused, not emulated`, async (t) => {
      const f = await fixture(t, { kind: "text", text: "never sent" });
      const caps = await f.adapter.getCapabilities(f.model, { signal: live() });
      const req = requestUsingMissingFeature(f.model, caps);
      if (req === undefined) {
        t.skip("the model supports every feature the suite can exercise");
        return;
      }
      const err = await rejection(
        mode === "stream" ? drain(f.adapter.stream(req, { signal: live() })) : f.adapter.generate(req, { signal: live() }),
      );
      assert.equal(err.code, "unsupported_capability");
      assert.equal(f.requestCount(), 0);
    });
  }

  it("forwards model, maxOutputTokens, system and stopSequences unchanged", async (t) => {
    const f = await fixture(t, { kind: "text", text: "forwarded" });
    const caps = await f.adapter.getCapabilities(f.model, { signal: live() });
    const stop = caps.features.stopSequences === "supported" ? { stopSequences: ["END-OF-TURN"] } : {};
    const req = request(f.model, { maxOutputTokens: 321, ...stop });
    const check = (sent: ForwardedRequest | undefined, mode: string): void => {
      assert.ok(sent !== undefined, `${mode}: the harness reports the request it saw`);
      assert.equal(sent.model, f.model);
      assert.equal(sent.maxOutputTokens, 321, `${mode}: the output cap is forwarded exactly`);
      assert.equal(sent.system, req.system);
      if ("stopSequences" in stop) assert.deepEqual(sent.stopSequences, stop.stopSequences);
    };
    await f.adapter.generate(req, { signal: live() });
    check(f.lastRequest(), "generate");
    // The stream path builds its request separately in most adapters (R2).
    const g = await fixture(t, { kind: "text", text: "forwarded" });
    await drain(g.adapter.stream(req, { signal: live() }));
    check(g.lastRequest(), "stream");
  });
}
