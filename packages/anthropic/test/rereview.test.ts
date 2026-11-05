// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for the re-review of the first round of fixes (SF-1, N-A, N-B).
import { test } from "node:test";
import assert from "node:assert/strict";
import v8 from "node:v8";
import vm from "node:vm";
import { BodyStream, type BodyReader } from "../src/index.js";
import { MODEL } from "./support/scenarios.js";
import { drain, failure, live, make, req } from "./support/harness.js";
import { sseEvent, sseResponse } from "./support/transport.js";

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;

// ------------------------------------------------ SF-1: no per-chunk retention

test("SF-1: reading many tiny chunks does not keep every chunk alive until the stream ends", async () => {
  const CHUNKS = 300_000;
  let served = 0;
  const reader: BodyReader = {
    read: async () => (served++ < CHUNKS ? { done: false, value: new Uint8Array(1) } : new Promise<never>(() => undefined)),
    cancel: async () => undefined,
  };
  const ctl = new AbortController();
  const body = new BodyStream({ getReader: () => reader }, ctl.signal, Number.MAX_SAFE_INTEGER);
  gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < CHUNKS; i++) await body.next();
  gc();
  const growth = process.memoryUsage().heapUsed - before;
  // On the first pushed head this was about 350 bytes per chunk: over 100 MiB for these chunks.
  assert.ok(growth < 16 * 1024 * 1024, `heap grew by ${(growth / 1048576).toFixed(1)} MiB while the stream was still open`);
  ctl.abort();
  await body.close();
});

test("SF-1: aborting while a read is pending still fails promptly with cancelled", async () => {
  const reader: BodyReader = { read: () => new Promise<never>(() => undefined), cancel: async () => undefined };
  const ctl = new AbortController();
  const body = new BodyStream({ getReader: () => reader }, ctl.signal, 1_000);
  const pending = body.next();
  ctl.abort();
  const err = await failure(pending as Promise<unknown>);
  assert.equal(err.code, "cancelled");
});

// ------------------------------------------------------- N-B: empty event lines

for (const line of ["event:\n", "event\n", "event: \n"]) {
  test(`N-B: a flood of ${JSON.stringify(line)} lines is counted, quickly, and is not retryable`, async () => {
    const text = sseEvent("message_start", { type: "message_start", message: { id: "m", model: MODEL, usage: { input_tokens: 5, output_tokens: 1 } } }) + line.repeat(2_000_000);
    const { adapter } = make((_c, counter) => sseResponse(counter, text, 65_536));
    const t0 = Date.now();
    const err = await failure(drain(adapter.stream(req(), { signal: live() })));
    assert.equal(err.code, "invalid_response");
    assert.equal(err.details.reason, "too_many_ignored_events");
    assert.equal(err.retryable, false);
    assert.ok(Date.now() - t0 < 2_000);
  });
}

test("N-B: a normal event line followed by data is not counted", async () => {
  const body =
    sseEvent("message_start", { type: "message_start", message: { id: "m", model: MODEL, usage: { input_tokens: 5, output_tokens: 1 } } }) +
    sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
    sseEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }) +
    sseEvent("message_stop", { type: "message_stop" });
  const { adapter } = make((_c, counter) => sseResponse(counter, body), { limits: { maxIgnoredEvents: 1 } });
  assert.equal((await adapter.generate(req(), { signal: live() })).stopReason, "end_turn");
});

// ---------------------------------------------------- N-A: explicit zero usage

const reply = (start: Record<string, number>, delta: Record<string, number>, text = "x".repeat(4_000)): string =>
  sseEvent("message_start", { type: "message_start", message: { id: "m", model: MODEL, usage: start } }) +
  sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
  sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
  sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
  sseEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: delta }) +
  sseEvent("message_stop", { type: "message_stop" });

test("N-A: an explicit zero usage alongside real content is refused, not charged as zero", async () => {
  for (const [name, body] of [
    ["zero input", reply({ input_tokens: 0, output_tokens: 0 }, { output_tokens: 9 })],
    ["zero output", reply({ input_tokens: 10, output_tokens: 0 }, { output_tokens: 0 })],
  ] as const) {
    const { adapter } = make((_c, counter) => sseResponse(counter, body));
    const err = await failure(adapter.generate(req(), { signal: live() }));
    assert.equal(err.details.reason, "implausible_usage", name);
    assert.equal(err.retryable, false);
  }
});

test("N-A: a fully cached prompt (zero input tokens, cache reads reported) is real usage, and so is an empty reply", async () => {
  const cached = make((_c, counter) => sseResponse(counter, reply({ input_tokens: 0, cache_read_input_tokens: 500, output_tokens: 1 }, { output_tokens: 4 }, "hi")));
  assert.equal((await cached.adapter.generate(req(), { signal: live() })).usage.cacheReadTokens, 500);
  const empty = make((_c, counter) => sseResponse(counter, reply({ input_tokens: 7, output_tokens: 0 }, { output_tokens: 0 }, "")));
  assert.equal((await empty.adapter.generate(req(), { signal: live() })).usage.outputTokens, 0);
});

test("N-H: a final output count of zero is refused even though the stream's start reported one token", async () => {
  const lie = make((_c, counter) => sseResponse(counter, reply({ input_tokens: 10, output_tokens: 1 }, { output_tokens: 0 })));
  const err = await failure(lie.adapter.generate(req(), { signal: live() }));
  assert.equal(err.details.reason, "implausible_usage");
  // Thinking is billed as output: a thinking-only reply with a zero final count is just as implausible.
  const thinking =
    sseEvent("message_start", { type: "message_start", message: { id: "m", model: MODEL, usage: { input_tokens: 10, output_tokens: 1 } } }) +
    sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }) +
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
    sseEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }) +
    sseEvent("message_stop", { type: "message_stop" });
  const t = make((_c, counter) => sseResponse(counter, thinking));
  assert.equal((await failure(t.adapter.generate(req(), { signal: live() }))).details.reason, "implausible_usage");
  // A real count is fine, with or without thinking.
  const ok = make((_c, counter) => sseResponse(counter, thinking.replace('"output_tokens":0', '"output_tokens":12')));
  assert.equal((await ok.adapter.generate(req(), { signal: live() })).usage.outputTokens, 12);
});
