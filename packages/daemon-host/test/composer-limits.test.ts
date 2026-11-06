// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createRunBudget, type GenerateResult } from "@axis/providers";
import { ProjectMutex, createComposerRunsHandlers, createComposerService, runComposerLoop, type ComposerRunTools } from "../src/index.js";
import { composerRig, START, until, type ComposerRig, type ComposerRigOptions } from "./composer-rig.js";

// Review r1 S3 and S4: the safety paths whose removal passed before, and the fan-out caps.

async function setup(t: TestContext, options: ComposerRigOptions): Promise<ComposerRig> {
  const c = await composerRig(options);
  t.after(() => c.cleanup());
  mkdirSync(join(c.root, ".github"), { recursive: true });
  return c;
}

const ended = (c: ComposerRig, runId: string) => () => !c.service.get(runId).live;
const reasonOf = (e: unknown): unknown => (e as { details?: Record<string, unknown> }).details?.["reason"];
const codeOf = (e: unknown): unknown => (e as { code?: unknown }).code;

test("DMN-5: a side effect whose audit row cannot be written stops the run; the model is never asked again", async (t) => {
  const c = await setup(t, { replies: [{ kind: "tool_use", name: "write_file", input: { path: "src/a.txt", content: "hi" } }, { kind: "text", text: "never sent" }], failAudit: (a) => a === "broker.result" });
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await until(ended(c, run.runId));
  assert.deepEqual([c.service.get(run.runId).state, c.service.get(run.runId).reason], ["FAILED", "TOOL_FAILED"]);
  assert.equal(readFileSync(join(c.root, "src/a.txt"), "utf8"), "hi", "the write happened; its result could not be recorded");
  assert.equal(c.wire(), 1, "no further provider request after an unrecorded side effect");
});

test("the host-wide limit of live runs answers E_BACKPRESSURE and creates nothing", async (t) => {
  const c = await setup(t, { replies: [{ kind: "tool_use", name: "write_file", input: { path: ".github/x.yml", content: "x" } }], maxActive: 1 });
  const other = c.journal.createWorkspace({ projectId: "p", branch: "axis/y", baseRef: "main", baseSha: "b".repeat(40), createdBy: "user" }).value;
  c.journal.transitionWorkspace(other.id, "READY");
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await until(() => c.service.get(run.runId).awaitingApproval);
  await assert.rejects(c.service.start(START(other.id), new AbortController().signal), (e) => codeOf(e) === "E_BACKPRESSURE");
  assert.equal(c.journal.listRuns({ workspaceId: other.id }).length, 0);
  c.service.cancel(run.runId);
  await until(ended(c, run.runId));
});

test("a CLI run is not a composer run: get, cancel and events answer E_NOT_FOUND and list leaves it out", async (t) => {
  const c = await setup(t, { replies: [] });
  const cli = c.journal.createRun({ workspaceId: c.workspaceId, kind: "cli", createdBy: "user" }).value.id;
  assert.throws(() => c.service.get(cli), (e) => codeOf(e) === "E_NOT_FOUND");
  assert.throws(() => c.service.cancel(cli), (e) => codeOf(e) === "E_NOT_FOUND");
  assert.throws(() => c.service.events(cli, 0, 10), (e) => codeOf(e) === "E_NOT_FOUND");
  assert.deepEqual(c.service.list({ limit: 50 }), []);
  assert.equal(c.journal.getRun(cli)?.state, "QUEUED", "untouched");
});

test("a run whose last transition could not be written can be cancelled, so the workspace is not stuck until a restart", async (t) => {
  const c = await setup(t, { replies: [{ kind: "text", text: "answer" }, { kind: "text", text: "second" }] });
  let failEnd = true;
  const journal = {
    getWorkspace: (id: string) => c.journal.getWorkspace(id),
    createRun: (i: Parameters<typeof c.journal.createRun>[0]) => c.journal.createRun(i),
    getRun: (id: string) => c.journal.getRun(id),
    listRuns: (o?: Parameters<typeof c.journal.listRuns>[0]) => c.journal.listRuns(o),
    transitionRun: (id: string, to: Parameters<typeof c.journal.transitionRun>[1], o?: Parameters<typeof c.journal.transitionRun>[2]) => {
      if (failEnd && to === "REVIEWING") throw new Error("disk full");
      return c.journal.transitionRun(id, to, o);
    },
  };
  const service = createComposerService({ journal, engine: c.agent, now: () => c.r.clock.now() });
  t.after(() => service.dispose());
  const { run } = await service.start(START(c.workspaceId, { mode: "ask" }), new AbortController().signal);
  await until(() => !service.get(run.runId).live);
  assert.equal(service.get(run.runId).state, "RUNNING", "the end could not be recorded");
  await assert.rejects(service.start(START(c.workspaceId, { mode: "ask" }), new AbortController().signal), (e) => reasonOf(e) === "active_run");
  failEnd = false;
  assert.deepEqual([service.cancel(run.runId).state, c.journal.getRun(run.runId)?.reason], ["CANCELLED", "USER_CANCELLED"]);
  const next = await service.start(START(c.workspaceId, { mode: "ask" }), new AbortController().signal);
  await until(() => !service.get(next.run.runId).live);
  assert.equal(service.get(next.run.runId).state, "REVIEWING");
});

test("axis.runs handlers refuse a non-user identity themselves, behind the policy row (defence in depth)", async (t) => {
  const c = await setup(t, { replies: [] });
  const handlers = createComposerRunsHandlers({ service: c.service, journal: c.journal, mutex: new ProjectMutex() });
  const ctx = (actor: string) => ({ identity: { actor, windowId: "win-1" }, signal: new AbortController().signal }) as never;
  for (const [method, payload] of [["list", {}], ["get", { runId: "r1" }], ["events", { runId: "r1" }], ["start", { ...START(c.workspaceId) }]] as const) {
    await assert.rejects(Promise.resolve(handlers[method](ctx("agent:composer.x"), payload as never)), (e) => codeOf(e) === "E_NOT_FOUND", method);
  }
  assert.deepEqual(await handlers.list(ctx("user"), {} as never), { runs: [] });
  assert.equal(c.journal.listRuns({}).length, 0);
});

function fakeTools(content: string): ComposerRunTools & { calls: number } {
  const t = {
    calls: 0,
    specs: [{ name: "read_file", description: "d", inputSchema: { type: "object" } }],
    async invoke() {
      t.calls++;
      return { ok: true as const, content };
    },
  };
  return t;
}

const reply = (calls: number): GenerateResult => ({
  model: "mock-model",
  content: Array.from({ length: calls }, (_, i) => ({ type: "tool_use" as const, id: `t${i}`, name: "read_file", input: { path: "a" } })),
  stopReason: "tool_use",
  usage: { inputTokens: 1, outputTokens: 1 },
});

test("S4: a reply that asks for more tool calls than the cap runs none of them and ends the run", async () => {
  const tools = fakeTools("x");
  const base = { runId: "r1", mode: "agent" as const, prompt: "p", model: "mock-model", budget: createRunBudget({}), signal: new AbortController().signal, emit: () => undefined, tools };
  const over = await runComposerLoop({ ...base, provider: { generate: async () => reply(17) } });
  assert.deepEqual(over, { state: "FAILED", reason: "TOOL_CALL_LIMIT" });
  assert.equal(tools.calls, 0);
  let turns = 0;
  const atCap = await runComposerLoop({ ...base, provider: { generate: async () => (turns++ === 0 ? reply(16) : { ...reply(0), stopReason: "end_turn" }) } });
  assert.deepEqual(atCap, { state: "REVIEWING", reason: null }, "exactly the cap is allowed");
  assert.equal(tools.calls, 16);
});

test("S4: the run stops once its tool results exceed the per-run size cap", async () => {
  const tools = fakeTools("x".repeat(1000));
  const end = await runComposerLoop({
    runId: "r1", mode: "agent", prompt: "p", model: "mock-model", budget: createRunBudget({}), signal: new AbortController().signal, emit: () => undefined, tools,
    provider: { generate: async () => reply(1) },
    maxResultChars: 2500,
  });
  assert.deepEqual(end, { state: "FAILED", reason: "TOOL_RESULT_LIMIT" });
  assert.equal(tools.calls, 3, "the third result crossed the cap, and nothing more was asked");
  // Exactly at the cap is allowed (review r2 N3): two results of 1000 against a cap of 2000, then the model ends.
  const exact = fakeTools("x".repeat(1000));
  let turns = 0;
  const atCap = await runComposerLoop({
    runId: "r2", mode: "agent", prompt: "p", model: "mock-model", budget: createRunBudget({}), signal: new AbortController().signal, emit: () => undefined, tools: exact,
    provider: { generate: async () => (turns++ < 2 ? reply(1) : { ...reply(0), stopReason: "end_turn" }) },
    maxResultChars: 2000,
  });
  assert.deepEqual(atCap, { state: "REVIEWING", reason: null });
  assert.equal(exact.calls, 2);
});
