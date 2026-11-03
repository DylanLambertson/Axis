// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// ANT-1 (threat model §4.5, ROADMAP 1b gate): redirects are not followed and
// the key is not sent to the target; an oversized stream event, deeply nested
// JSON and an error body that echoes the key are handled without leaking it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderError, type StreamEvent } from "@axis/providers";
import { ANTHROPIC_ORIGIN } from "../src/index.js";
import { MODEL } from "./support/scenarios.js";
import { CREDENTIAL, PATTERN_KEY, drain, failure, guarded, live, make, req, run, secretForms, views } from "./support/harness.js";
import { chunkBytes, jsonResponse, response, sseEvent, sseResponse, textReply, type Handler } from "./support/transport.js";

const ATTACKER = "https://attacker.invalid/steal";

function noLeak(texts: string[], extra: string[] = []): void {
  for (const t of texts) for (const f of [...secretForms(), ...extra]) assert.ok(!t.includes(f), `leaked ${f.slice(0, 6)}… in: ${t.slice(0, 80)}`);
}

// ---------------------------------------------------------------- redirects

for (const status of [301, 302, 303, 307, 308]) {
  test(`ANT-1: a ${status} redirect is not followed and the key goes nowhere else`, async () => {
    const handler: Handler = (call, counter) => response(counter, status, [], { location: ATTACKER });
    const { adapter, fake } = make(handler);
    const err = await failure(adapter.generate(req(), { signal: live() }));
    assert.equal(err.code, "invalid_response");
    assert.equal(err.details.reason, "redirect");
    const posts = fake.calls.filter((c) => c.init.method === "POST");
    assert.equal(posts.length, 1, "one request, no retry");
    for (const c of fake.calls) {
      assert.ok(c.url.startsWith(`${ANTHROPIC_ORIGIN}/`), "only the fixed origin is ever called");
      assert.equal(c.init.redirect, "manual", "the fetch is told never to follow");
      assert.ok(!c.url.includes("attacker"));
    }
    assert.equal(fake.counter.open, 0, "the redirect body was released unread");
    noLeak(views(err), ["attacker", "Location"]);
  });
}

test("ANT-1: a redirect on a GET (models, validateConnection) is refused too", async () => {
  const { adapter, fake } = make((_c, counter) => response(counter, 307, [], { location: ATTACKER }));
  const check = await adapter.validateConnection({ signal: live() });
  assert.equal(check.ok, false);
  if (!check.ok) assert.equal(check.error.details.reason, "redirect");
  const err = await failure(adapter.listModels({ signal: live() }));
  assert.equal(err.code, "invalid_response");
  for (const c of fake.calls) assert.equal(c.init.redirect, "manual");
});

test("ANT-1: a response that a fetch followed anyway is discarded", async () => {
  for (const extra of [{ redirected: true }, { url: ATTACKER }, { type: "opaqueredirect" }]) {
    const { adapter } = make((_c, counter) => response(counter, 200, chunkBytes(textReply("hi"), 32), {}, extra));
    const err = await failure(adapter.generate(req(), { signal: live() }));
    assert.equal(err.details.reason, "redirect", JSON.stringify(extra));
  }
});

test("ANT-1: a redirect through the guard never reaches the log with the target or the key", async () => {
  const { adapter } = make((_c, counter) => response(counter, 302, [], { location: `${ATTACKER}?k=${CREDENTIAL}` }));
  const { g, logs } = guarded(adapter);
  const err = await failure(g.generate(req(), run()));
  assert.equal(err.code, "invalid_response");
  noLeak([...views(err), JSON.stringify(logs)], ["attacker"]);
});

// ------------------------------------------------------- oversized events

const startEvent = sseEvent("message_start", { type: "message_start", message: { id: "m1", model: MODEL, usage: { input_tokens: 5, output_tokens: 1 } } });

async function streamError(body: string | Uint8Array[], limits: Parameters<typeof make>[1] = {}, chunk = 1024): Promise<{ err: ProviderError; events: StreamEvent[]; open: number; reads: number }> {
  const { adapter, fake } = make((_c, counter) => (typeof body === "string" ? sseResponse(counter, body, chunk) : response(counter, 200, body)), limits);
  const events: StreamEvent[] = [];
  const err = await failure(
    (async () => {
      for await (const ev of adapter.stream(req(), { signal: live() })) events.push(ev);
    })(),
  );
  return { err, events, open: fake.counter.open, reads: fake.counter.reads };
}

test("ANT-1: a single event over the default cap (1 MiB) is refused and carries nothing of it", async () => {
  const big = `event: content_block_delta\ndata: ${CREDENTIAL}${"x".repeat(1_100_000)}\n\n`;
  const { err, open } = await streamError(startEvent + big, {}, 65_536);
  assert.equal(err.code, "invalid_response");
  assert.equal(err.details.reason, "event_too_large");
  assert.equal(open, 0);
  noLeak(views(err));
});

test("ANT-1: data spread over many lines counts toward the event cap", async () => {
  const lines = Array.from({ length: 200 }, () => `data: ${"y".repeat(40)}`).join("\n");
  const { err } = await streamError(`${startEvent}event: x\n${lines}\n\n`, { limits: { maxEventBytes: 4_000 } });
  assert.equal(err.details.reason, "event_too_large");
});

test("ANT-1: a body with no newline cannot grow the buffer past the line cap", async () => {
  const chunks = Array.from({ length: 200 }, () => new Uint8Array(10_000).fill(0x61));
  const { err, reads } = await streamError(chunks, { limits: { maxLineBytes: 50_000 } });
  assert.equal(err.details.reason, "event_too_large");
  assert.ok(reads <= 9, `stopped reading after ${reads} reads (2 are the model lookup)`);
});

test("ANT-1: a body over the total cap is refused", async () => {
  let text = startEvent;
  for (let i = 0; i < 200; i++) text += sseEvent("content_block_start", { type: "content_block_start", index: i, content_block: { type: "unknown_kind" } });
  const { err } = await streamError(text, { limits: { maxStreamBytes: 5_000, maxIgnoredEvents: 100_000 } }, 200);
  assert.equal(err.details.reason, "response_too_large");
});

test("ANT-1: endless pings are bounded by the ignored-event cap", async () => {
  const pings = Array.from({ length: 300 }, () => sseEvent("ping", { type: "ping" })).join("");
  const { err, events } = await streamError(startEvent + pings, { limits: { maxIgnoredEvents: 50 } });
  assert.equal(err.details.reason, "too_many_ignored_events");
  assert.equal(events[0]?.type, "message_start");
});

test("ANT-1: comment lines and unknown event types count as ignored", async () => {
  const noise = Array.from({ length: 100 }, (_v, i) => (i % 2 === 0 ? ": keep-alive\n" : sseEvent("brand_new_event", { type: "brand_new_event" }))).join("");
  const { err } = await streamError(startEvent + noise, { limits: { maxIgnoredEvents: 30 } });
  assert.equal(err.details.reason, "too_many_ignored_events");
});

test("ANT-1: too many events is refused", async () => {
  let text = startEvent + sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (let i = 0; i < 100; i++) text += sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a" } });
  const { err } = await streamError(text, { limits: { maxRawEvents: 40 } });
  assert.equal(err.details.reason, "too_many_events");
});

test("ANT-1: invalid UTF-8 is refused", async () => {
  const bad = new Uint8Array([...new TextEncoder().encode("event: x\ndata: "), 0xff, 0xfe, 0x0a, 0x0a]);
  const { err } = await streamError([...chunkBytes(startEvent, 64), bad]);
  assert.equal(err.details.reason, "bad_encoding");
});

test("ANT-1: an oversized response through the guard leaks nothing into errors or logs", async () => {
  const big = `event: content_block_delta\ndata: ${CREDENTIAL} ${PATTERN_KEY} ${"z".repeat(2_000)}\n\n`;
  const { adapter } = make((_c, counter) => sseResponse(counter, startEvent + big, 512), { limits: { maxEventBytes: 1_000 } });
  const { g, logs } = guarded(adapter);
  const err = await failure(drain(g.stream(req(), run())));
  assert.equal(err.code, "invalid_response");
  noLeak([...views(err), JSON.stringify(logs)]);
});

// ------------------------------------------------------ deeply nested JSON

test("ANT-1: a deeply nested event is refused without being parsed", async () => {
  const depth = 200_000;
  const evil = `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":${"[".repeat(depth)}${"]".repeat(depth)}}\n\n`;
  const t0 = Date.now();
  const { err } = await streamError(startEvent + evil, { limits: { maxEventBytes: 2_000_000, maxLineBytes: 2_000_000 } }, 65_536);
  assert.equal(err.details.reason, "event_too_deep");
  assert.ok(Date.now() - t0 < 2_000, "refused quickly");
});

test("ANT-1: brackets inside strings do not count as nesting", async () => {
  const text = textReply(`[[[[[[[[[[[[[[[[[[[[ {{{{{{{{{{{{{{{{{{{{ \\"[[[`, { split: 7 });
  const { adapter } = make((_c, counter) => sseResponse(counter, text));
  const r = await adapter.generate(req(), { signal: live() });
  assert.equal(r.stopReason, "end_turn");
});

test("ANT-1: tool input nested far beyond the protocol depth is refused by the stream validator", async () => {
  const input = `{"a":${"[".repeat(5_000)}${"]".repeat(5_000)}}`;
  let text = sseEvent("message_start", { type: "message_start", message: { id: "m", model: MODEL, usage: { input_tokens: 5, output_tokens: 1 } } });
  text += sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} } });
  text += sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: input } });
  text += sseEvent("content_block_stop", { type: "content_block_stop", index: 0 });
  text += sseEvent("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } });
  text += sseEvent("message_stop", { type: "message_stop" });
  const { adapter } = make((_c, counter) => sseResponse(counter, text, 4_096));
  const err = await failure(adapter.generate(req({ tools: [{ name: "read_file", description: "d", inputSchema: { type: "object" } }] }), { signal: live() }));
  assert.equal(err.code, "invalid_response");
  assert.equal(err.details.reason, "tool_input_unbounded");
  const { g } = guarded(adapter);
  const err2 = await failure(g.generate(req({ tools: [{ name: "read_file", description: "d", inputSchema: { type: "object" } }] }), run()));
  assert.equal(err2.code, "invalid_response");
});

test("ANT-1: a deeply nested models response is refused", async () => {
  const { adapter } = make((_c, counter) => jsonResponse(counter, 200, `{"data":${"[".repeat(1_000)}${"]".repeat(1_000)}}`));
  const err = await failure(adapter.listModels({ signal: live() }));
  assert.equal(err.code, "invalid_response");
});

// -------------------------------------------- error bodies that echo the key

const HOSTILE_BODY = (type: string): string =>
  JSON.stringify({ type: "error", error: { type, message: `invalid x-api-key: ${CREDENTIAL} / ${encodeURIComponent(CREDENTIAL)} / ${PATTERN_KEY}` }, request_id: `req_${CREDENTIAL}` });

for (const [status, type, code] of [
  [400, "invalid_request_error", "invalid_request"],
  [401, "authentication_error", "authentication"],
  [403, "permission_error", "permission_denied"],
  [404, "not_found_error", "not_found"],
  [413, "request_too_large", "context_length_exceeded"],
  [429, "rate_limit_error", "rate_limited"],
  [500, "api_error", "server_error"],
  [529, "overloaded_error", "overloaded"],
] as const) {
  test(`ANT-1: a ${status} body that echoes the key does not leak it (raw adapter and guard)`, async () => {
    const handler: Handler = (_c, counter) => jsonResponse(counter, status, HOSTILE_BODY(type), { "x-echo": CREDENTIAL, "retry-after": "2" });
    const { adapter } = make(handler);
    const err = await failure(adapter.generate(req(), { signal: live() }));
    assert.equal(err.code, code);
    assert.equal(err.details.status, status);
    assert.deepEqual(Object.keys(err.details).sort().filter((k) => !["status", "retryAfterMs"].includes(k)), []);
    noLeak(views(err));
    const { g, logs } = guarded(adapter);
    const gerr = await failure(g.generate(req(), run()));
    assert.equal(gerr.code, code);
    noLeak([...views(gerr), JSON.stringify(logs)]);
    // The same, from a stream.
    const serr = await failure(drain(g.stream(req(), run())));
    noLeak([...views(serr), JSON.stringify(logs)]);
  });
}

test("ANT-1: a mid-stream error event that echoes the key does not leak it", async () => {
  const text = startEvent + sseEvent("error", HOSTILE_BODY("overloaded_error"));
  const { adapter } = make((_c, counter) => sseResponse(counter, text));
  const { g, logs } = guarded(adapter);
  const err = await failure(drain(g.stream(req(), run())));
  assert.equal(err.code, "overloaded");
  noLeak([...views(err), JSON.stringify(logs)]);
});

test("ANT-1: an unknown stream error type is a server_error with fixed text", async () => {
  const text = startEvent + sseEvent("error", { type: "error", error: { type: `weird_${CREDENTIAL}`, message: CREDENTIAL } });
  const { adapter } = make((_c, counter) => sseResponse(counter, text));
  const err = await failure(drain(adapter.stream(req(), { signal: live() })));
  assert.equal(err.code, "server_error");
  noLeak(views(err));
});

test("ANT-1: a 400 that says the prompt is too long maps to context_length_exceeded, still without the body", async () => {
  const body = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `prompt is too long: 250000 tokens > 200000 maximum ${CREDENTIAL}` } });
  const { adapter } = make((_c, counter) => jsonResponse(counter, 400, body));
  const err = await failure(adapter.generate(req(), { signal: live() }));
  assert.equal(err.code, "context_length_exceeded");
  noLeak(views(err));
  assert.ok(!views(err).some((v) => v.includes("250000")));
});

test("ANT-1: an enormous or binary error body is read only in part and changes nothing", async () => {
  const chunks = Array.from({ length: 500 }, () => new Uint8Array(65_536).fill(0xff));
  const { adapter, fake } = make((_c, counter) => response(counter, 429, chunks, { "retry-after": "7" }));
  const err = await failure(adapter.generate(req(), { signal: live() }));
  assert.equal(err.code, "rate_limited");
  assert.equal(err.details.retryAfterMs, 7_000);
  assert.equal(fake.counter.open, 0);
  assert.ok(fake.counter.reads < 20, "the error body was not read to the end");
});

test("ANT-1: the key never appears in any request the adapter made except the x-api-key header", async () => {
  const { adapter, fake } = make((_c, counter) => sseResponse(counter, textReply("ok")));
  await adapter.generate(req(), { signal: live() });
  await adapter.validateConnection({ signal: live() }).catch(() => undefined);
  for (const c of fake.calls) {
    assert.ok(!c.url.includes(CREDENTIAL));
    assert.ok(!(c.init.body ?? "").includes(CREDENTIAL));
    for (const [k, v] of Object.entries(c.init.headers)) if (k !== "x-api-key") assert.ok(!v.includes(CREDENTIAL), k);
    assert.equal(c.init.headers["x-api-key"], CREDENTIAL);
  }
  assert.ok(ProviderError.name === "ProviderError");
});
