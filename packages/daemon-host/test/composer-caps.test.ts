// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { composerRunSchema } from "@axis/protocol";
import { createRunBudget, type GenerateResult } from "@axis/providers";
import { DEFAULT_TOOL_CAPS, TOOL_LIMIT_REASONS, createComposerService, jsonDepth, resolveToolCaps, runComposerLoop, type ComposerRunTools, type LoopInput, type ToolCaps } from "../src/index.js";
import { composerRig, START, until } from "./composer-rig.js";

// Review r1 S4: count, byte and depth caps on tool calls and results, per reply and per run, closed reasons, fail closed.

function fakeTools(content: string | ((n: number) => string) = "x"): ComposerRunTools & { calls: number } {
  const t = {
    calls: 0,
    specs: [{ name: "read_file", description: "d", inputSchema: { type: "object" } }],
    async invoke() {
      t.calls++;
      return { ok: true as const, content: typeof content === "string" ? content : content(t.calls) };
    },
  };
  return t;
}

const reply = (inputs: readonly unknown[]): GenerateResult => ({
  model: "mock-model",
  content: inputs.map((input, i) => ({ type: "tool_use" as const, id: `t${i}`, name: "read_file", input: input as never })),
  stopReason: inputs.length === 0 ? "end_turn" : "tool_use",
  usage: { inputTokens: 1, outputTokens: 1 },
});

/** A provider that answers `script` in order, then ends the turn. */
const scripted = (script: readonly (readonly unknown[])[]): LoopInput["provider"] => {
  let i = 0;
  return { generate: async () => reply(script[i++] ?? []) };
};

async function loop(caps: Partial<ToolCaps>, script: readonly (readonly unknown[])[], tools = fakeTools()) {
  const end = await runComposerLoop({
    runId: "r1", mode: "agent", prompt: "p", model: "mock-model", budget: createRunBudget({}), signal: new AbortController().signal, emit: () => undefined,
    tools, provider: scripted(script), caps,
  });
  return { end, calls: tools.calls };
}

const A = { path: "a" }; // {"path":"a"}: 12 bytes of JSON
const failed = (reason: string) => ({ state: "FAILED", reason });
const REVIEW = { state: "REVIEWING", reason: null };

test("S4: calls per run: the reply that would pass the cap runs none of its calls; exactly the cap is allowed", async () => {
  assert.deepEqual(await loop({ callsPerRun: 5 }, [[A, A], [A, A], [A, A]]), { end: failed("TOOL_CALL_RUN_LIMIT"), calls: 4 });
  assert.deepEqual(await loop({ callsPerRun: 4 }, [[A, A], [A, A]]), { end: REVIEW, calls: 4 });
});

test("S4: input depth: one over-deep input stops the whole reply before any call; exactly the cap is allowed", async () => {
  const at = { a: { b: { c: 1 } } }; // depth 3
  const over = { a: { b: { c: {} } } }; // depth 4
  assert.deepEqual(await loop({ inputDepth: 3 }, [[at]]), { end: REVIEW, calls: 1 });
  assert.deepEqual(await loop({ inputDepth: 3 }, [[A, over]]), { end: failed("TOOL_INPUT_DEPTH"), calls: 0 });
  assert.deepEqual(await loop({ inputDepth: 3 }, [[[[[[1]]]]]]), { end: failed("TOOL_INPUT_DEPTH"), calls: 0 }, "arrays count too");
});

test("S4: input bytes per reply are UTF-8 bytes of the JSON input; exactly the cap is allowed", async () => {
  assert.deepEqual(await loop({ inputBytesPerReply: 24 }, [[A, A]]), { end: REVIEW, calls: 2 });
  assert.deepEqual(await loop({ inputBytesPerReply: 24 }, [[A, A, A]]), { end: failed("TOOL_INPUT_LIMIT"), calls: 0 });
  // {"path":"é"} is 12 UTF-16 units but 13 bytes.
  assert.deepEqual(await loop({ inputBytesPerReply: 12 }, [[{ path: "é" }]]), { end: failed("TOOL_INPUT_LIMIT"), calls: 0 });
  assert.deepEqual(await loop({ inputBytesPerReply: 24, inputBytesPerRun: 1000 }, [[A, A], [A, A], [A, A]]), { end: REVIEW, calls: 6 }, "the reply cap resets per reply");
});

test("S4: input bytes per run add up over replies; exactly the cap is allowed", async () => {
  assert.deepEqual(await loop({ inputBytesPerRun: 36 }, [[A], [A], [A]]), { end: REVIEW, calls: 3 });
  assert.deepEqual(await loop({ inputBytesPerRun: 36 }, [[A], [A], [A], [A]]), { end: failed("TOOL_INPUT_RUN_LIMIT"), calls: 3 });
});

test("S4: result bytes per reply stop the run at the call that crosses them; the cap resets per reply", async () => {
  const tools = () => fakeTools("x".repeat(1000));
  assert.deepEqual(await loop({ resultBytesPerReply: 2000 }, [[A, A, A]], tools()), { end: failed("TOOL_RESULT_REPLY_LIMIT"), calls: 3 });
  assert.deepEqual(await loop({ resultBytesPerReply: 2000 }, [[A, A], [A, A]], tools()), { end: REVIEW, calls: 4 });
  // "é" x 600 is 600 UTF-16 units and 1200 bytes.
  assert.deepEqual(await loop({ resultBytesPerReply: 1000 }, [[A]], fakeTools("é".repeat(600))), { end: failed("TOOL_RESULT_REPLY_LIMIT"), calls: 1 });
});

test("S4: result bytes per run are UTF-8 bytes", async () => {
  assert.deepEqual(await loop({ resultBytesPerRun: 2000 }, [[A], [A]], fakeTools("é".repeat(500))), { end: REVIEW, calls: 2 });
  assert.deepEqual(await loop({ resultBytesPerRun: 1999 }, [[A], [A]], fakeTools("é".repeat(500))), { end: failed("TOOL_RESULT_LIMIT"), calls: 2 });
});

test("S4: the defaults hold their documented values, and a cap override must be a positive safe integer", () => {
  assert.deepEqual({ ...DEFAULT_TOOL_CAPS }, {
    callsPerReply: 16, callsPerRun: 128, inputDepth: 8, inputBytesPerReply: 2_097_152, inputBytesPerRun: 8_388_608, resultBytesPerReply: 1_048_576, resultBytesPerRun: 4_194_304,
  });
  assert.deepEqual(resolveToolCaps({ callsPerRun: 3 }), { ...DEFAULT_TOOL_CAPS, callsPerRun: 3 });
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    assert.throws(() => resolveToolCaps({ inputDepth: bad }), RangeError, String(bad));
  }
  assert.throws(() => createComposerService({ journal: {} as never, engine: {} as never, now: () => 0, toolCaps: { callsPerReply: 0 } }), RangeError, "refused at configuration, not at the first run");
});

test("S4: the limit reasons are a closed set of run reasons the contract accepts", () => {
  assert.deepEqual([...TOOL_LIMIT_REASONS], ["TOOL_CALL_LIMIT", "TOOL_CALL_RUN_LIMIT", "TOOL_INPUT_DEPTH", "TOOL_INPUT_LIMIT", "TOOL_INPUT_RUN_LIMIT", "TOOL_RESULT_REPLY_LIMIT", "TOOL_RESULT_LIMIT"]);
  const base = { runId: "run-1", workspaceId: "ws-1", mode: "agent", providerId: "mock", modelId: "m", state: "FAILED", createdAt: "2026-11-05T10:00:00.000Z", startedAt: "2026-11-05T10:00:00.000Z", endedAt: "2026-11-05T10:00:01.000Z", live: false, awaitingApproval: false, usage: null };
  for (const reason of TOOL_LIMIT_REASONS) assert.ok(composerRunSchema.safeParse({ ...base, reason }).success, reason);
});

test("S4: jsonDepth counts objects and arrays, and stops early on a very deep value", () => {
  assert.deepEqual([jsonDepth(1, 8), jsonDepth(null, 8), jsonDepth({}, 8), jsonDepth([[], {}], 8), jsonDepth({ a: [{ b: 1 }] }, 8)], [0, 0, 1, 2, 3]);
  let deep: unknown = 1;
  for (let i = 0; i < 200_000; i++) deep = [deep];
  assert.equal(jsonDepth(deep, 8), 9, "the walk stops one past the cap, with no stack overflow");
});

test("S4 through the service: a cap ends the run FAILED with its reason in the journal, and nothing ran", async (t) => {
  const deep = { path: "a", extra: { a: { b: { c: {} } } } };
  const c = await composerRig({ replies: [{ kind: "tool_use", name: "read_file", input: deep }], toolCaps: { inputDepth: 3 } });
  t.after(() => c.cleanup());
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await until(() => !c.service.get(run.runId).live);
  assert.deepEqual([c.journal.getRun(run.runId)?.state, c.journal.getRun(run.runId)?.reason], ["FAILED", "TOOL_INPUT_DEPTH"]);
  assert.equal(c.audit.list({ limit: 200 }).filter((e) => e.action.startsWith("broker.")).length, 0, "no call reached the broker");
});
