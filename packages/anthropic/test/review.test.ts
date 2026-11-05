// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for the independent review of the first pushed head
// (S1, S6, S7 and the nits N2 to N4, N5, N7, N8). Each fails on that head.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRunBudget, type BudgetUsageInfo } from "@axis/providers";
import { ANTHROPIC_ORIGIN, createAnthropicAdapter, type FetchLike, type KeyPurpose } from "../src/index.js";
import { MODEL } from "./support/scenarios.js";
import { CREDENTIAL, drain, failure, guarded, live, make, req, run } from "./support/harness.js";
import { chunkBytes, fakeFetch, jsonResponse, modelInfo, response, sseEvent, sseResponse, textReply, type Handler, type OpenCounter } from "./support/transport.js";

const start = (usage?: Record<string, number>): string =>
  sseEvent("message_start", { type: "message_start", message: { id: "m", model: MODEL, ...(usage === undefined ? {} : { usage }) } });
const textBlock = (text: string): string =>
  sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
  sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
  sseEvent("content_block_stop", { type: "content_block_stop", index: 0 });
const mstop = sseEvent("message_stop", { type: "message_stop" });
const mdelta = (usage?: Record<string, number>): string =>
  sseEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, ...(usage === undefined ? {} : { usage }) });

// ------------------------------------------------ S1: missing usage is not zero

test("S1: a stream that reports no usage is refused, never charged as zero", async () => {
  const big = "x".repeat(4_000);
  for (const [name, body] of [
    ["no usage anywhere", start() + textBlock(big) + mdelta() + mstop],
    ["input but no final output count", start({ input_tokens: 10, output_tokens: 1 }) + textBlock(big) + mdelta() + mstop],
    ["final output but no input", start() + textBlock(big) + mdelta({ output_tokens: 5 }) + mstop],
  ] as const) {
    const { adapter } = make((_c, counter) => sseResponse(counter, body));
    const err = await failure(adapter.generate(req(), { signal: live() }));
    assert.equal(err.code, "invalid_response", name);
    assert.equal(err.details.reason, "missing_usage", name);
    assert.equal(err.retryable, false);
  }
});

test("S1: through a 150-token budget, usage-less replies are charged conservatively and the run stops", async () => {
  const { adapter, fake } = make((_c, counter) => sseResponse(counter, start() + textBlock("x".repeat(4_000)) + mdelta() + mstop));
  const { g } = guarded(adapter);
  const budget = createRunBudget({ maxTokens: 150 });
  const recorded: BudgetUsageInfo[] = [];
  const spy = { beforeRequest: budget.beforeRequest.bind(budget), recordUsage: async (u: BudgetUsageInfo) => (recorded.push(u), budget.recordUsage(u)) };
  const outcomes: string[] = [];
  for (let i = 0; i < 5; i++) {
    try {
      await g.generate(req({ maxOutputTokens: 40 }), run(spy as never));
      outcomes.push("completed");
    } catch (e) {
      outcomes.push((e as { code: string }).code);
    }
  }
  assert.ok(!outcomes.includes("completed"), outcomes.join());
  assert.ok(recorded.length >= 1 && recorded.every((u) => u.charged === "estimated" && u.usage.outputTokens >= 40), "charged the output cap, not zero");
  assert.ok(outcomes.includes("budget_exceeded"), `the budget stopped the run: ${outcomes.join()}`);
  assert.ok(fake.calls.filter((c) => c.init.method === "POST").length < 5, "requests stopped before all five were sent");
});

// ------------------------------------------------------ S6: every line counts

const bodyOf = (text: string, chunk = 65_536): Handler => (_c, counter) => sseResponse(counter, text, chunk);

async function flood(line: string, copies: number): Promise<{ err: Awaited<ReturnType<typeof failure>>; ms: number }> {
  const text = start({ input_tokens: 5, output_tokens: 1 }) + line.repeat(copies);
  const { adapter } = make(bodyOf(text));
  const t0 = Date.now();
  const err = await failure(drain(adapter.stream(req(), { signal: live() })));
  return { err, ms: Date.now() - t0 };
}

for (const [name, line] of [["blank lines", "\n"], ["id fields", "id:1\n"], ["retry fields", "retry: 5\n"], ["repeated event lines", "event:x\n"], ["CR-only blank lines", "\r"]] as const) {
  test(`S6: a flood of ${name} is cut at the ignored cap, quickly, and is not retryable`, async () => {
    const { err, ms } = await flood(line, 2_000_000);
    assert.equal(err.code, "invalid_response");
    assert.equal(err.details.reason, "too_many_ignored_events");
    assert.equal(err.retryable, false);
    assert.ok(ms < 2_000, `took ${ms} ms`);
  });
}

test("S6: eight MiB of newlines does not cost seconds", async () => {
  const chunk = "\n".repeat(65_536);
  const { adapter } = make((_c, counter) => response(counter, 200, [...chunkBytes(start({ input_tokens: 5, output_tokens: 1 }), 64), ...Array.from({ length: 128 }, () => new TextEncoder().encode(chunk))]));
  const t0 = Date.now();
  const err = await failure(drain(adapter.stream(req(), { signal: live() })));
  assert.equal(err.details.reason, "too_many_ignored_events");
  assert.ok(Date.now() - t0 < 2_000);
});

test("N5: an event with no data is skipped, not fatal; a BOM is stripped from the first line only", async () => {
  const body =
    "﻿" + start({ input_tokens: 5, output_tokens: 1 }) +
    "event: lonely\n\n" +
    "﻿data: {\"type\":\"ping\"}\n\n" + // a BOM mid-stream is not stripped, so this field is unknown
    textBlock("kept") +
    mdelta({ output_tokens: 3 }) +
    mstop;
  const { adapter } = make(bodyOf(body, 7));
  const r = await adapter.generate(req(), { signal: live() });
  assert.equal(r.content[0]?.type === "text" && r.content[0].text, "kept");
});

// -------------------------------------------------- S7: redirects, and a real fetch

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

/** Real `fetch`, with the fixed origin pointed at a local server. `url` is reported as the original unless a redirect was followed. */
function viaLocal(port: number, redirect?: "follow"): FetchLike {
  return async (url, init) => {
    const res = await fetch(url.replace(ANTHROPIC_ORIGIN, `http://127.0.0.1:${port}`), { ...init, ...(redirect === undefined ? {} : { redirect }) });
    return { status: res.status, headers: res.headers, body: res.body, redirected: res.redirected, type: res.type, url: res.redirected ? res.url : url };
  };
}

interface Seen {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
}

async function targets(mode: "models" | "messages"): Promise<{ stolen: Seen[]; port: number; close(): void }> {
  const stolen: Seen[] = [];
  const b = await listen((rq, rs) => {
    stolen.push({ path: rq.url ?? "", headers: rq.headers });
    rs.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const a = await listen((rq, rs) => {
    const path = rq.url ?? "";
    if (mode === "messages" && path === `/v1/models/${MODEL}`) {
      rs.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(modelInfo(MODEL)));
      return;
    }
    rs.writeHead(307, { location: `http://127.0.0.1:${b.port}/stolen${path}` }).end();
  });
  return {
    stolen,
    port: a.port,
    close: () => {
      for (const s of [a.server, b.server]) {
        s.closeAllConnections();
        s.close();
      }
    },
  };
}

for (const mode of ["models", "messages"] as const) {
  test(`S7: with the real fetch, a redirect on the ${mode} path never reaches the target, and nothing carries the key there`, async (t) => {
    const env = await targets(mode);
    t.after(() => env.close());
    const adapter = createAnthropicAdapter({ connectionId: "c", apiKey: () => CREDENTIAL, fetch: viaLocal(env.port) });
    const err = await failure(adapter.generate(req(), { signal: live() }));
    assert.equal(err.code, "invalid_response");
    assert.equal(err.details.reason, "redirect");
    const check = await adapter.validateConnection({ signal: live() });
    assert.ok(!check.ok && check.error.details.reason === "redirect");
    assert.deepEqual(env.stolen, [], "the redirect target received no request at all");
  });
}

test("S7: control: a fetch that does follow redirects would hand the key to the target (why `manual` matters)", async (t) => {
  const env = await targets("models");
  t.after(() => env.close());
  const adapter = createAnthropicAdapter({ connectionId: "c", apiKey: () => CREDENTIAL, fetch: viaLocal(env.port, "follow") });
  const err = await failure(adapter.getCapabilities(MODEL, { signal: live() }));
  assert.equal(err.details.reason, "redirect", "the adapter still refuses the followed response");
  assert.equal(env.stolen.length, 1, "but the request already went out");
  assert.equal(env.stolen[0]?.headers["x-api-key"], CREDENTIAL, "detection is not prevention: the daemon must pass Node's own fetch");
});

test("S7: a redirect served on the capabilities GET during generate sends nothing anywhere else", async () => {
  const f = fakeFetch((_c, counter) => response(counter, 302, [], { location: "https://attacker.invalid/x" }));
  const a = createAnthropicAdapter({ connectionId: "c", apiKey: () => CREDENTIAL, fetch: f.fetch });
  const err = await failure(a.generate(req(), { signal: live() }));
  assert.equal(err.details.reason, "redirect");
  assert.equal(f.calls.length, 1, "only the capabilities request was made; nothing went to the target or to /v1/messages");
  for (const c of f.calls) assert.ok(c.url.startsWith(`${ANTHROPIC_ORIGIN}/`) && !c.url.includes("attacker"));
});

test("S7: validateConnection on a redirect makes exactly one call, to the fixed origin", async () => {
  const f = fakeFetch((_c, counter) => response(counter, 301, [], { location: "https://attacker.invalid/x" }));
  const a = createAnthropicAdapter({ connectionId: "c", apiKey: () => CREDENTIAL, fetch: f.fetch });
  const check = await a.validateConnection({ signal: live() });
  assert.equal(check.ok, false);
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0]?.url.startsWith(`${ANTHROPIC_ORIGIN}/`));
});

// ------------------------------------------------------------------ nits

test("N2: `.` and `..` model ids are refused and sent nowhere; an encoded query character is not mistaken for a redirect", async () => {
  const { adapter, fake } = make((_c, counter) => jsonResponse(counter, 200, {}));
  for (const id of [".", ".."]) assert.equal((await failure(adapter.getCapabilities(id, { signal: live() }))).code, "invalid_request");
  assert.equal(fake.calls.length, 0);
  const quote = make((call, counter) => ({
    ...jsonResponse(counter, 200, { data: [{ id: "a" }], has_more: true, last_id: "a'b" }),
    url: call.url.replace("'", "%27"),
  }));
  const models = await quote.adapter.listModels({ signal: live() });
  assert.equal(models[0]?.id, "a");
});

test("N3: a 200 with the wrong content type is an invalid response, not a retryable network error", async () => {
  const html = (_c: unknown, counter: OpenCounter) => response(counter, 200, chunkBytes("<html>sign in to the wifi</html>", 16), { "content-type": "text/html" });
  const { adapter } = make(html);
  const err = await failure(drain(adapter.stream(req(), { signal: live() })));
  assert.equal(err.code, "invalid_response");
  assert.equal(err.details.reason, "unexpected_content_type");
  assert.equal(err.retryable, false);
  const json = make((_c, counter) => response(counter, 200, chunkBytes("<html></html>", 8), { "content-type": "text/html" }));
  assert.equal((await failure(json.adapter.listModels({ signal: live() }))).details.reason, "unexpected_content_type");
});

test("N4: a 413 and a stream request_too_large are request-size problems, not context-window problems", async () => {
  const { adapter } = make((_c, counter) => jsonResponse(counter, 413, { type: "error", error: { type: "request_too_large", message: "x" } }));
  const err = await failure(adapter.generate(req(), { signal: live() }));
  assert.equal(err.code, "invalid_request");
  assert.equal(err.details.reason, "request_too_large");
  const s = make((_c, counter) => sseResponse(counter, start({ input_tokens: 1, output_tokens: 1 }) + sseEvent("error", { type: "error", error: { type: "request_too_large" } })));
  const serr = await failure(drain(s.adapter.stream(req(), { signal: live() })));
  assert.equal(serr.code, "invalid_request");
  assert.equal(serr.details.reason, "request_too_large");
});

test("N8: the key supplier is told why the key is read", async () => {
  const purposes: KeyPurpose[] = [];
  const { adapter } = make(
    (call, counter) => (call.url.endsWith("/count_tokens") ? jsonResponse(counter, 200, { input_tokens: 3 }) : call.init.method === "GET" ? jsonResponse(counter, 200, { data: [], has_more: false }) : sseResponse(counter, textReply("ok"))),
    { apiKey: (p) => (purposes.push(p), CREDENTIAL) },
  );
  await adapter.validateConnection({ signal: live() });
  assert.deepEqual(purposes, ["validate_connection"]);
  purposes.length = 0;
  await adapter.generate(req(), { signal: live() });
  await adapter.countTokens?.(req(), { signal: live() });
  await adapter.listModels({ signal: live() });
  assert.ok(purposes.length >= 3 && purposes.every((p) => p === "provider_request"), purposes.join());
});

// ------------------------------------------- N7: thinking is progress, pings are not

function slowThinking(counter: OpenCounter, deltas: number, gapMs: number): ReturnType<Handler> {
  const enc = new TextEncoder();
  const steps: string[] = [
    start({ input_tokens: 5, output_tokens: 1 }),
    sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
    ...Array.from({ length: deltas }, () => sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } })),
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
    textBlock("answer").replace(/index":0/g, 'index":1'),
    mdelta({ output_tokens: 9 }),
    mstop,
  ];
  let i = 0;
  let live = true;
  counter.open += 1;
  const end = (): void => {
    if (live) {
      live = false;
      counter.open -= 1;
    }
  };
  return {
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/event-stream" : null) },
    body: {
      getReader: () => ({
        read: async () => {
          if (!live) return { done: true };
          const step = steps[i++];
          if (step === undefined) {
            end();
            return { done: true };
          }
          if (step.includes("thinking_delta")) await new Promise((r) => setTimeout(r, gapMs));
          return { done: false, value: enc.encode(step) };
        },
        cancel: async () => end(),
      }),
    },
  };
}

test("N7: a model that thinks for longer than the idle timeout is not cut off, because thinking is progress", async () => {
  const { adapter } = make((_c, counter) => slowThinking(counter, 12, 30), { keepAliveMs: 10 });
  const { g } = guarded(adapter, { idleTimeoutMs: 120 });
  const events = await drain(g.stream(req(), run()));
  assert.equal(events.at(-1)?.type, "message_stop");
});

test("N7: control: with no progress signal the same stream hits the idle timeout", async () => {
  const { adapter } = make((_c, counter) => slowThinking(counter, 12, 30), { keepAliveMs: 3_600_000 });
  const { g } = guarded(adapter, { idleTimeoutMs: 120 });
  const err = await failure(drain(g.stream(req(), run())));
  assert.equal(err.code, "timeout");
});
