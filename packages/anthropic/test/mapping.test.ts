// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// SSE parsing and the Anthropic-to-normalized event mapping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectStream, type StreamEvent } from "@axis/providers";
import { MODEL } from "./support/scenarios.js";
import { drain, failure, live, make, req } from "./support/harness.js";
import { chunkBytes, response, sseEvent, sseResponse, textReply, type OpenCounter } from "./support/transport.js";

const start = (usage: Record<string, number> = { input_tokens: 10, output_tokens: 1 }, extra: Record<string, unknown> = {}): string =>
  sseEvent("message_start", { type: "message_start", message: { id: "msg_1", model: MODEL, usage, ...extra } });
const blockStart = (index: number, block: Record<string, unknown>): string => sseEvent("content_block_start", { type: "content_block_start", index, content_block: block });
const delta = (index: number, d: Record<string, unknown>): string => sseEvent("content_block_delta", { type: "content_block_delta", index, delta: d });
const stop = (index: number): string => sseEvent("content_block_stop", { type: "content_block_stop", index });
const mdelta = (reason: string | null, usage: Record<string, number> = { output_tokens: 5 }): string =>
  sseEvent("message_delta", { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage });
const mstop = sseEvent("message_stop", { type: "message_stop" });

async function events(body: string, chunk = 64, opts: Parameters<typeof make>[1] = {}): Promise<{ evs: StreamEvent[]; adapter: ReturnType<typeof make>["adapter"]; open: () => number }> {
  const { adapter, fake } = make((_c, counter: OpenCounter) => sseResponse(counter, body, chunk), opts);
  return { evs: await drain(adapter.stream(req(), { signal: live() })), adapter, open: () => fake.counter.open };
}

const textOf = (evs: readonly StreamEvent[]): string => evs.flatMap((e) => (e.type === "content_block_delta" && e.delta.type === "text" ? [e.delta.text] : [])).join("");

test("a whole reply maps to the normalized grammar, with input usage right after message_start", async () => {
  const { evs } = await events(textReply("Hello, world."));
  assert.equal(evs[0]?.type, "message_start");
  const second = evs[1];
  assert.ok(second?.type === "usage" && second.usage.inputTokens === 12);
  const result = await collectStream((async function* () { yield* evs; })());
  assert.equal(result.content[0]?.type === "text" && result.content[0].text, "Hello, world.");
  assert.equal(result.stopReason, "end_turn");
});

test("lines may end in LF, CRLF or CR, and a BOM and comments are accepted", async () => {
  const base = textReply("abc");
  for (const [name, text] of [
    ["crlf", base.replace(/\n/g, "\r\n")],
    ["cr", base.replace(/\n/g, "\r")],
    ["bom", `﻿${base}`],
    ["comments", `: hello\n${base.replace(/\n\n/g, "\n\n: keep-alive\n")}`],
  ] as const) {
    const { evs } = await events(text, 5);
    assert.equal(textOf(evs), "abc", name);
  }
});

test("a CRLF split across two chunks does not produce an extra blank line", async () => {
  const text = textReply("split").replace(/\n/g, "\r\n");
  for (const size of [1, 2, 3, 7]) {
    const { evs } = await events(text, size);
    assert.equal(textOf(evs), "split", `chunk ${size}`);
  }
});

test("multi-byte characters survive chunk boundaries of one byte", async () => {
  const s = "héllo ☃ 😀 日本語";
  const { evs } = await events(textReply(s, { split: 3 }), 1);
  assert.equal(textOf(evs), s);
});

test("data split over several lines is joined with a newline", async () => {
  const body = `${start()}event: content_block_start\ndata: {"type":"content_block_start",\ndata: "index":0,"content_block":{"type":"text","text":""}}\n\n${delta(0, { type: "text_delta", text: "x" })}${stop(0)}${mdelta("end_turn")}${mstop}`;
  const { evs } = await events(body);
  assert.equal(textOf(evs), "x");
});

test("unknown events, blocks and deltas are ignored and counted, never executed", async () => {
  const body =
    start() +
    sseEvent("ping", { type: "ping" }) +
    sseEvent("brand_new_event", { type: "brand_new_event", payload: { do: "something" } }) +
    blockStart(0, { type: "server_tool_use", id: "x", name: "web_search", input: {} }) +
    delta(0, { type: "something_delta", v: 1 }) +
    stop(0) +
    blockStart(1, { type: "text", text: "" }) +
    delta(1, { type: "citations_delta", citation: {} }) +
    delta(1, { type: "text_delta", text: "kept" }) +
    stop(1) +
    mdelta("end_turn") +
    mstop;
  const { evs, adapter } = await events(body);
  assert.equal(textOf(evs), "kept");
  assert.equal(adapter.stats.ignoredEvents, 4, "ping, unknown event, unknown block, unknown delta on a mapped block");
});

test("wire block indices are remapped around ignored blocks; thinking deltas do not count as ignored events", async () => {
  let body = start() + blockStart(0, { type: "thinking", thinking: "" });
  for (let i = 0; i < 200; i++) body += delta(0, { type: "thinking_delta", thinking: "hmm" });
  body += delta(0, { type: "signature_delta", signature: "sig" }) + stop(0);
  body += blockStart(1, { type: "text", text: "" }) + delta(1, { type: "text_delta", text: "answer" }) + stop(1) + mdelta("end_turn") + mstop;
  const { evs } = await events(body, 256, { limits: { maxIgnoredEvents: 5 } });
  const starts = evs.filter((e) => e.type === "content_block_start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0]?.type === "content_block_start" && starts[0].index, 0, "the text block is index 0 in the normalized stream");
  assert.equal(textOf(evs), "answer");
});

test("usage: cache counters map separately and counters never go down", async () => {
  const body =
    start({ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 }) +
    blockStart(0, { type: "text", text: "" }) +
    delta(0, { type: "text_delta", text: "a" }) +
    stop(0) +
    mdelta("end_turn", { input_tokens: 3, output_tokens: 20 }) +
    mstop;
  const { adapter } = make((_c, counter) => sseResponse(counter, body));
  const r = await adapter.generate(req(), { signal: live() });
  assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 20, cacheReadTokens: 4, cacheWriteTokens: 2 });
});

test("stop reasons map to the normalized set; unknown values become other", async () => {
  for (const [wire, want] of [
    ["end_turn", "end_turn"],
    ["max_tokens", "max_tokens"],
    ["stop_sequence", "stop_sequence"],
    ["refusal", "refusal"],
    ["pause_turn", "other"],
    ["model_context_window_exceeded", "other"],
    ["something_new", "other"],
    [null, "other"],
  ] as const) {
    const body = start() + blockStart(0, { type: "text", text: "" }) + delta(0, { type: "text_delta", text: "a" }) + stop(0) + mdelta(wire) + mstop;
    const { adapter } = make((_c, counter) => sseResponse(counter, body));
    assert.equal((await adapter.generate(req(), { signal: live() })).stopReason, want, String(wire));
  }
});

test("a tool call maps its id, name and streamed input", async () => {
  const body =
    start() +
    blockStart(0, { type: "tool_use", id: "toolu_a", name: "read_file", input: {} }) +
    delta(0, { type: "input_json_delta", partial_json: '{"pa' }) +
    delta(0, { type: "input_json_delta", partial_json: 'th":"a.ts"}' }) +
    stop(0) +
    mdelta("tool_use") +
    mstop;
  const { adapter } = make((_c, counter) => sseResponse(counter, body));
  const r = await adapter.generate(req({ tools: [{ name: "read_file", description: "d", inputSchema: { type: "object" } }] }), { signal: live() });
  assert.deepEqual(r.content, [{ type: "tool_use", id: "toolu_a", name: "read_file", input: { path: "a.ts" } }]);
  assert.equal(r.stopReason, "tool_use");
});

const reasonOf = async (body: string, via: "generate" | "stream" = "generate"): Promise<string | undefined> => {
  const { adapter } = make((_c, counter) => sseResponse(counter, body));
  const p = via === "generate" ? adapter.generate(req(), { signal: live() }) : drain(adapter.stream(req(), { signal: live() }));
  const err = await failure(p);
  return err.details.reason ?? err.code;
};

test("malformed or inconsistent streams fail with a fixed reason", async () => {
  const text = blockStart(0, { type: "text", text: "" });
  assert.equal(await reasonOf(start() + blockStart(0, { type: "tool_use", id: "t", name: "n", input: { a: 1 } }), "stream"), "unexpected_tool_input");
  assert.equal(await reasonOf(start() + blockStart(0, { type: "tool_use", name: "n" }), "stream"), "malformed_event");
  assert.equal(await reasonOf(start() + delta(3, { type: "text_delta", text: "x" }), "stream"), "delta_outside_block");
  assert.equal(await reasonOf(start() + stop(0), "stream"), "stop_outside_block");
  assert.equal(await reasonOf(start() + text + text, "stream"), "duplicate_block_index");
  assert.equal(await reasonOf(start() + start(), "stream"), "duplicate_message_start");
  assert.equal(await reasonOf(start() + text + delta(0, { type: "text_delta" }), "stream"), "malformed_event");
  assert.equal(await reasonOf('event: x\ndata: "just a string"\n\n', "stream"), "malformed_event");
  assert.equal(await reasonOf('event: x\ndata: {"type": 5}\n\n', "stream"), "malformed_event");
  assert.equal(await reasonOf("event: message_start\ndata: {\"type\":\"message_start\"}\n\n", "stream"), "malformed_event");
});

test("duplicate tool ids and a tool_use stop without a tool are refused by the shared validator", async () => {
  const tool = (i: number): string => blockStart(i, { type: "tool_use", id: "toolu_same", name: "read_file", input: {} }) + delta(i, { type: "input_json_delta", partial_json: "{}" }) + stop(i);
  assert.equal(await reasonOf(start() + tool(0) + tool(1) + mdelta("tool_use") + mstop), "duplicate_tool_use_id");
  assert.equal(await reasonOf(start() + mdelta("tool_use") + mstop), "tool_use_stop_without_tool");
});

test("a stream that ends before message_stop is a network error, and is released", async () => {
  const { adapter, fake } = make((_c, counter) => sseResponse(counter, start() + blockStart(0, { type: "text", text: "" })));
  const err = await failure(drain(adapter.stream(req(), { signal: live() })));
  assert.equal(err.code, "network");
  assert.equal(err.details.reason, "truncated_stream");
  assert.equal(err.retryable, true);
  assert.equal(fake.counter.open, 0);
});

test("a body read that fails mid-stream is a network error with fixed text", async () => {
  const { adapter } = make((_c, _counter) => ({
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => {
        let n = 0;
        return {
          read: async () => {
            if (n++ === 0) return { done: false, value: new TextEncoder().encode(start()) };
            throw new Error("socket hang up secret-detail");
          },
          cancel: async () => undefined,
        };
      },
    },
  }));
  const err = await failure(drain(adapter.stream(req(), { signal: live() })));
  assert.equal(err.code, "network");
  assert.ok(!err.message.includes("secret-detail"));
});

test("reading stops at message_stop: trailing bytes are not parsed and the response is released", async () => {
  const { evs, open } = await events(textReply("done") + "data: this is not even json\n\n".repeat(5));
  assert.equal(textOf(evs), "done");
  assert.equal(open(), 0);
});

test("the stream body is requested with stream true and the right accept header", async () => {
  const { adapter, fake } = make((_c, counter) => response(counter, 200, chunkBytes(textReply("x"), 32)));
  await drain(adapter.stream(req(), { signal: live() }));
  const post = fake.calls.find((c) => c.init.method === "POST");
  assert.equal(post?.init.headers["accept"], "text/event-stream");
  assert.equal(JSON.parse(post?.init.body ?? "{}").stream, true);
});
