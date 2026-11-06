// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Challenge, RunEvent } from "@axis/protocol";
import { composerRunsMethods } from "@axis/protocol";
import type { MockReply } from "@axis/providers";
import { createComposerService } from "../src/index.js";
import { allEvents, composerRig, START, until, type ComposerRig, type ComposerRigOptions } from "./composer-rig.js";

const write = (path: string, content = "hello"): MockReply => ({ kind: "tool_use", name: "write_file", input: { path, content } });
const say = (text: string): MockReply => ({ kind: "text", text });

async function setup(t: TestContext, options: ComposerRigOptions): Promise<ComposerRig> {
  const c = await composerRig(options);
  t.after(() => c.cleanup());
  // The repository already has its CI directory (the broker creates files, not directories).
  mkdirSync(join(c.root, ".github", "workflows"), { recursive: true });
  return c;
}

const ended = (c: ComposerRig, runId: string) => () => ["REVIEWING", "FAILED", "CANCELLED"].includes(c.service.get(runId).state) && !c.service.get(runId).live;
const kinds = (events: readonly RunEvent[]): string[] => events.map((e) => (e.type === "state" ? `state:${e.state}` : e.type === "tool" ? `tool:${e.tool}:${e.outcome}:${String(e.reason)}` : e.type === "approval" ? `approval:${e.state}` : e.type));
type Row = { readonly actor: string; readonly outcome: string; readonly payload: Record<string, unknown> };
const auditRows = (c: ComposerRig, action: string): Row[] =>
  c.audit.list({ limit: 200 }).filter((e) => e.action === action).map((e) => ({ actor: e.actor, outcome: e.outcome, payload: (e.payload ?? {}) as Record<string, unknown> }));

test("edit mode: a write inside the worktree runs through the broker, is audited, and the run ends in review", async (t) => {
  const c = await setup(t, { replies: [write("src/a.txt", "hi"), say("done")] });
  const { run, replayed } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  assert.equal(replayed, false);
  assert.equal(run.state, "RUNNING");
  assert.ok(composerRunsMethods.start.response.safeParse({ run, replayed }).success);
  await until(ended(c, run.runId));
  const done = c.service.get(run.runId);
  assert.deepEqual([done.state, done.reason, done.live, done.mode, done.providerId], ["REVIEWING", null, false, "edit", "mock"]);
  assert.equal(readFileSync(join(c.root, "src/a.txt"), "utf8"), "hi");
  assert.deepEqual(kinds(allEvents(c, run.runId)), ["state:RUNNING", "usage", "tool:write_file:ok:null", "usage", "text", "state:REVIEWING"]);
  const page = c.service.events(run.runId, 0, 200);
  assert.equal(page.complete, true);
  assert.ok(composerRunsMethods.events.response.safeParse(page).success);
  assert.equal(c.journal.getRun(run.runId)?.kind, "composer");
  // DMN-5: the decision and the result of the side effect, by the run's own agent identity.
  const decision = auditRows(c, "broker.decision")[0];
  assert.equal(decision?.actor, `agent:composer.${run.runId}`);
  assert.equal(decision?.payload["decision"], "allow");
  assert.equal(auditRows(c, "broker.result")[0]?.payload["bytesWritten"], 2);
  assert.equal(c.sawTools(), true, "edit mode offers the tools");
});

test("WT-3 and DMN-3: a write to a protected path waits for the user's approval, then runs and records the approver and expiry", async (t) => {
  const c = await setup(t, { replies: [write(".github/workflows/ci.yml", "on: push"), say("ok")] });
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await until(() => c.service.get(run.runId).awaitingApproval);
  assert.equal(existsSync(join(c.root, ".github/workflows/ci.yml")), false, "nothing is written before the approval");
  const requested = allEvents(c, run.runId).find((e) => e.type === "approval");
  assert.ok(requested?.type === "approval");
  assert.deepEqual([requested.state, requested.paths, requested.reasons.some((r) => r.startsWith("protected:"))], ["requested", [{ access: "write", path: ".github/workflows/ci.yml" }], true]);
  const pending = (await c.user.call("axis.approvals", "pending", {})).result?.["challenges"] as Challenge[];
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.digest, requested.digest, "the event names the listed challenge");
  const res = await c.user.call("axis.approvals", "resolve", { challengeId: pending[0]?.challengeId, decision: "approve", digest: pending[0]?.digest });
  assert.equal(res.ok, true);
  await until(ended(c, run.runId));
  assert.equal(readFileSync(join(c.root, ".github/workflows/ci.yml"), "utf8"), "on: push");
  assert.deepEqual(kinds(allEvents(c, run.runId)).filter((k) => k.startsWith("approval") || k.startsWith("tool")), ["approval:requested", "approval:approved", "tool:write_file:ok:null"]);
  const decision = auditRows(c, "broker.decision")[0]?.payload ?? {};
  assert.equal(decision["decision"], "approved");
  assert.equal(decision["approvedBy"], "user");
  assert.match(String(decision["approvalId"]), /^chl:[0-9a-f]{32}$/);
  assert.ok(typeof decision["expiresAt"] === "number" && decision["expiresAt"] > c.r.clock.now());
  assert.equal(decision["protected"], true);
});

test("DMN-3: a denied approval writes nothing; the model is told and the run goes on to review", async (t) => {
  const c = await setup(t, { replies: [write(".github/workflows/ci.yml"), say("understood")] });
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await until(() => c.service.get(run.runId).awaitingApproval);
  const [challenge] = (await c.user.call("axis.approvals", "pending", {})).result?.["challenges"] as Challenge[];
  const agent = await c.r.connect(`agent:composer.${run.runId}#conn-7#win-1`);
  const self = await agent.call("axis.approvals", "resolve", { challengeId: challenge?.challengeId, decision: "approve", digest: challenge?.digest });
  assert.equal(self.error?.code, "E_POLICY_DENIED", "the run cannot approve itself");
  assert.equal(c.service.get(run.runId).awaitingApproval, true);
  await c.user.call("axis.approvals", "resolve", { challengeId: challenge?.challengeId, decision: "deny", digest: challenge?.digest });
  await until(ended(c, run.runId));
  assert.equal(existsSync(join(c.root, ".github/workflows/ci.yml")), false);
  assert.ok(kinds(allEvents(c, run.runId)).includes("tool:write_file:error:approval_declined"));
  assert.equal(c.service.get(run.runId).state, "REVIEWING");
  assert.equal(auditRows(c, "broker.decision")[0]?.outcome, "denied");
});

test("WT-1: writes through `..`, an absolute path and a planted symlink are refused and nothing lands outside", async (t) => {
  const runs = [];
  for (const attempt of ["dotdot", "absolute", "symlink"] as const) {
    // Each attempt has its own rig, and the path aims at THAT rig's outside directory, so the check below means something.
    const d = await composerRig({ replies: [], script: ({ outside }) => [write(attempt === "dotdot" ? "../outside/a.txt" : attempt === "absolute" ? join(outside, "b.txt") : "src/link/c.txt"), say("x")] });
    t.after(() => d.cleanup());
    if (attempt === "symlink") symlinkSync(d.outside, join(d.root, "src", "link"));
    const path = attempt;
    const { run } = await d.service.start(START(d.workspaceId), new AbortController().signal);
    await until(ended(d, run.runId));
    const tool = allEvents(d, run.runId).find((e) => e.type === "tool");
    assert.ok(tool?.type === "tool" && tool.outcome === "error", path);
    runs.push(tool.reason);
    for (const f of ["a.txt", "b.txt", "c.txt"]) assert.equal(existsSync(join(d.outside, f)), false, `${path} wrote outside`);
  }
  assert.equal(runs.length, 3);
  assert.equal(runs.every((r) => typeof r === "string" && r.length > 0), true, JSON.stringify(runs));
});

test("PRV-6: a run that reaches its request budget is stopped before the next provider request and records why", async (t) => {
  const c = await setup(t, { replies: [write("src/a.txt"), say("never sent")], budget: { maxRequests: 1 } });
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await until(ended(c, run.runId));
  const done = c.service.get(run.runId);
  assert.deepEqual([done.state, done.reason], ["FAILED", "BUDGET_REQUESTS"]);
  assert.equal(c.wire(), 1, "the second request never reached the provider");
  assert.equal(c.journal.getRun(run.runId)?.reason, "BUDGET_REQUESTS");
});

test("PRV-6: a token budget smaller than the first request stops the run before anything is sent", async (t) => {
  const c = await setup(t, { replies: [say("never sent")], budget: { maxTokens: 10 } });
  const { run } = await c.service.start(START(c.workspaceId, { prompt: "x".repeat(400) }), new AbortController().signal);
  await until(ended(c, run.runId));
  assert.deepEqual([c.service.get(run.runId).state, c.service.get(run.runId).reason], ["FAILED", "BUDGET_TOKENS"]);
  assert.equal(c.wire(), 0);
});

test("cancel during an approval withdraws it, writes nothing and ends the run CANCELLED", async (t) => {
  const c = await setup(t, { replies: [write(".github/x.yml"), say("never")] });
  const other = await c.r.connect("user#conn-5#win-2");
  const { run } = await c.service.start(START(c.workspaceId), new AbortController().signal);
  await until(() => c.service.get(run.runId).awaitingApproval);
  const after = c.service.cancel(run.runId);
  assert.equal(after.runId, run.runId);
  await until(ended(c, run.runId));
  assert.deepEqual([c.service.get(run.runId).state, c.service.get(run.runId).reason], ["CANCELLED", "USER_CANCELLED"]);
  assert.deepEqual((await c.user.call("axis.approvals", "pending", {})).result?.["challenges"], []);
  assert.deepEqual((await other.call("axis.approvals", "pending", {})).result?.["challenges"], [], "never listed for another window");
  assert.equal(existsSync(join(c.root, ".github/x.yml")), false);
  assert.equal(c.wire(), 1);
  assert.throws(() => c.service.cancel(run.runId), (e: Error & { details?: Record<string, unknown> }) => e.details?.["reason"] === "not_cancellable");
});

test("unknown provider or model creates nothing; one active run per workspace; ask mode offers no tools", async (t) => {
  const c = await setup(t, { replies: [write(".github/x.yml"), say("answer")] });
  const signal = new AbortController().signal;
  const reason = (e: unknown): unknown => (e as { details?: Record<string, unknown> }).details?.["reason"];
  await assert.rejects(c.service.start(START(c.workspaceId, { providerId: "other" }), signal), (e) => reason(e) === "provider_unknown");
  await assert.rejects(c.service.start(START(c.workspaceId, { modelId: "nope" }), signal), (e) => reason(e) === "model_unknown");
  assert.equal(c.journal.listRuns({ workspaceId: c.workspaceId }).length, 0);
  const { run } = await c.service.start(START(c.workspaceId), signal);
  await until(() => c.service.get(run.runId).awaitingApproval);
  await assert.rejects(c.service.start(START(c.workspaceId, { mode: "ask" }), signal), (e) => reason(e) === "active_run");
  assert.equal(c.journal.listRuns({ workspaceId: c.workspaceId }).length, 1, "the refused start created nothing");
  c.service.cancel(run.runId);
  await until(ended(c, run.runId));
  const ask = await c.service.start(START(c.workspaceId, { mode: "ask" }), signal);
  await until(ended(c, ask.run.runId));
  assert.equal(c.service.get(ask.run.runId).state, "REVIEWING");
  assert.equal(c.wire(), 2);
});

test("ask mode sends no tools to the provider", async (t) => {
  const c = await setup(t, { replies: [say("answer")] });
  const { run } = await c.service.start(START(c.workspaceId, { mode: "ask" }), new AbortController().signal);
  await until(ended(c, run.runId));
  assert.equal(c.sawTools(), false);
  assert.equal(c.service.get(run.runId).state, "REVIEWING");
});

test("model text is escaped: control, bidi and invisible characters never reach the activity stream raw", async (t) => {
  const c = await setup(t, { replies: [say("ok‮evil\u001b[31m​\nnext\ttab")] });
  const { run } = await c.service.start(START(c.workspaceId, { mode: "ask" }), new AbortController().signal);
  await until(ended(c, run.runId));
  const text = allEvents(c, run.runId).find((e) => e.type === "text");
  assert.ok(text?.type === "text");
  assert.equal(text.text, "ok\\u{202e}evil\\u{1b}[31m\\u{200b}\nnext\ttab");
  assert.ok(composerRunsMethods.events.response.safeParse(c.service.events(run.runId, 0, 200)).success);
});

test("events: the cursor returns only newer events and an unknown run is E_NOT_FOUND", async (t) => {
  const c = await setup(t, { replies: [say("a")] });
  const { run } = await c.service.start(START(c.workspaceId, { mode: "ask" }), new AbortController().signal);
  await until(ended(c, run.runId));
  const first = c.service.events(run.runId, 0, 2);
  assert.deepEqual(first.events.map((e) => e.seq), [1, 2]);
  assert.equal(first.complete, false);
  const rest = c.service.events(run.runId, first.nextSeq, 200);
  assert.ok(rest.events.every((e) => e.seq > 2));
  assert.equal(rest.complete, true);
  assert.throws(() => c.service.events("00000000-0000-4000-8000-00000000dead", 0, 10), (e: Error & { code?: string }) => e.code === "E_NOT_FOUND");
  writeFileSync(join(c.root, "keep.txt"), "x");
});

test("a run whose tools cannot be built is cancelled at once, never left QUEUED", async (t) => {
  const c = await setup(t, { replies: [say("x")] });
  const broken = createComposerService({
    journal: c.journal,
    engine: { provider: (id) => c.agent.provider(id), prepare: async () => () => { throw new Error("no tools"); } },
    now: () => c.r.clock.now(),
  });
  t.after(() => broken.dispose());
  await assert.rejects(broken.start(START(c.workspaceId), new AbortController().signal), (e: Error & { code?: string }) => e.code === "E_INTERNAL");
  const [run] = c.journal.listRuns({ workspaceId: c.workspaceId });
  assert.deepEqual([run?.state, run?.reason], ["CANCELLED", "START_FAILED"]);
  assert.equal(c.wire(), 0);
});
