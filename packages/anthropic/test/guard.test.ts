// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The adapter behind the providers guard: PRV-4 (destination, secret scan),
// PRV-6 (budget before every request), PRV-2 (redaction) and timeouts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunBudget, type StreamEvent } from "@axis/providers";
import { CREDENTIAL, PATTERN_KEY, drain, failure, guarded, live, make, req, run, secretForms, views } from "./support/harness.js";
import { MODEL } from "./support/scenarios.js";
import { jsonResponse, sseResponse, textReply, type Handler } from "./support/transport.js";

const ok: Handler = (call, counter) =>
  call.url.endsWith("/count_tokens") ? jsonResponse(counter, 200, { input_tokens: 31 }) : sseResponse(counter, textReply("fine", { usageIn: 20 }));
const posts = (calls: ReturnType<typeof make>["fake"]["calls"]) => calls.filter((c) => c.init.method === "POST");

test("a request through the guard works and its log names the destination (PRV-4)", async () => {
  const { adapter } = make(ok);
  const { g, logs } = guarded(adapter);
  const r = await g.generate(req(), run());
  assert.equal(r.stopReason, "end_turn");
  const start = logs.find((l) => l.event === "request_start");
  assert.equal(start?.destination, "https://api.anthropic.com");
  assert.equal(start?.providerId, "anthropic");
  const end = logs.find((l) => l.event === "request_end");
  assert.equal(end?.outcome, "completed");
  assert.deepEqual(await drain(g.stream(req(), run())).then((e) => e.filter((x) => x.type === "message_stop").length), 1);
});

test("PRV-4: a request that contains the stored key, or key-shaped text, is refused and sent nowhere", async () => {
  for (const secret of [CREDENTIAL, PATTERN_KEY, encodeURIComponent(CREDENTIAL)]) {
    const { adapter, fake } = make(ok);
    const { g } = guarded(adapter);
    const err = await failure(g.generate(req({ messages: [{ role: "user", content: [{ type: "text", text: `use ${secret} please` }] }] }), run()));
    assert.equal(err.code, "secret_in_request");
    assert.equal(posts(fake.calls).length, 0);
    const cerr = await failure(g.countTokens(req({ system: `key ${secret}` }), { runId: "r", signal: live() }));
    assert.equal(cerr.code, "secret_in_request");
    assert.equal(posts(fake.calls).length, 0);
  }
});

test("token counting goes through the guard and returns the provider's number", async () => {
  const { adapter } = make(ok);
  const { g } = guarded(adapter);
  assert.deepEqual(await g.countTokens(req(), { runId: "r", signal: live() }), { inputTokens: 31 });
});

test("PRV-6: a token budget stops the run before the next provider request, and the denial says why", async () => {
  const { adapter, fake } = make(ok, { pricing: () => undefined });
  const { g } = guarded(adapter);
  const budget = createRunBudget({ maxTokens: 150 });
  let done = 0;
  let denied: unknown;
  for (let i = 0; i < 20 && denied === undefined; i++) {
    try {
      await g.generate(req({ maxOutputTokens: 40 }), run(budget));
      done += 1;
    } catch (e) {
      denied = e;
    }
  }
  assert.ok(done >= 1, "some requests ran");
  assert.equal((denied as { code?: string }).code, "budget_exceeded");
  assert.equal((denied as { details?: { reason?: string } }).details?.reason, "tokens");
  assert.equal(posts(fake.calls).length, done, "no provider request was made after the denial");
});

test("PRV-6: a cost cap without pricing fails closed, and with pricing stops before the request", async () => {
  const unpriced = make(ok);
  const a = guarded(unpriced.adapter);
  const err = await failure(a.g.generate(req(), run(createRunBudget({ maxCostMicroUsd: 1_000_000 }))));
  assert.equal(err.code, "budget_exceeded");
  assert.equal(err.details.reason, "cost_unknown");
  assert.equal(posts(unpriced.fake.calls).length, 0);

  const priced = make(ok, { pricing: () => ({ inputMicroUsdPerMTok: 3_000_000, outputMicroUsdPerMTok: 15_000_000 }) });
  const b = guarded(priced.adapter);
  const err2 = await failure(b.g.generate(req({ maxOutputTokens: 4_000 }), run(createRunBudget({ maxCostMicroUsd: 10 }))));
  assert.equal(err2.code, "budget_exceeded");
  assert.equal(posts(priced.fake.calls).length, 0);
});

test("a cancelled stream is still charged for the input that was sent (usage arrives right after message_start)", async () => {
  const { adapter } = make((_c, counter) => sseResponse(counter, textReply("a long answer that will be cut short by the caller", { usageIn: 123 }), 16));
  const { g } = guarded(adapter);
  const recorded: Array<{ tokens: number; charged: string }> = [];
  const budget = {
    beforeRequest: async () => ({ allow: true as const }),
    recordUsage: async (u: { usage: { inputTokens: number }; charged: string }) => void recorded.push({ tokens: u.usage.inputTokens, charged: u.charged }),
  };
  const seen: StreamEvent[] = [];
  for await (const ev of g.stream(req(), run(budget as never))) {
    seen.push(ev);
    if (ev.type === "usage") break;
  }
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.tokens, 123);
});

test("an endless stream of pings ends in a timeout: pings do not reset the guard's idle timer", async () => {
  const startEvt = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", model: MODEL, usage: { input_tokens: 5, output_tokens: 1 } } })}\n\n`;
  let open = 0;
  const handler: Handler = (call, counter) => {
    if (call.init.method !== "POST") return jsonResponse(counter, 200, {});
    let first = true;
    let live = true;
    open += 1;
    const end = (): void => {
      if (live) {
        live = false;
        open -= 1;
      }
    };
    return {
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => {
            if (!live) return { done: true };
            if (first) {
              first = false;
              return { done: false, value: new TextEncoder().encode(startEvt) };
            }
            await new Promise((r) => setTimeout(r, 15));
            return live ? { done: false, value: new TextEncoder().encode("event: ping\ndata: {\"type\":\"ping\"}\n\n") } : { done: true };
          },
          cancel: async () => end(),
        }),
      },
    };
  };
  const { adapter } = make(handler, { limits: { maxIgnoredEvents: 1_000_000 } });
  const { g } = guarded(adapter, { idleTimeoutMs: 150 });
  const t0 = Date.now();
  const err = await failure(drain(g.stream(req(), run())));
  assert.equal(err.code, "timeout");
  assert.equal(err.details.reason, "idle");
  assert.ok(Date.now() - t0 < 3_000);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(open, 0, "the response was released");
});

test("PRV-2: nothing the guard logs or throws for a failing provider contains the key", async () => {
  const body = JSON.stringify({ type: "error", error: { type: "authentication_error", message: `bad key ${CREDENTIAL} ${PATTERN_KEY}` } });
  const { adapter } = make((_c, counter) => jsonResponse(counter, 401, body, { "x-echo": CREDENTIAL }));
  const { g, logs } = guarded(adapter);
  const err = await failure(g.generate(req(), run()));
  const check = await g.validateConnection({ signal: live() });
  const all = [...views(err), JSON.stringify(logs), JSON.stringify(check), ...(check.ok ? [] : views(check.error))];
  for (const t of all) for (const f of secretForms()) assert.ok(!t.includes(f));
});
