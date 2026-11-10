// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Redactor, acquireInstanceLock } from "@axis/audit";
import { composerRunsMethods, type Challenge } from "@axis/protocol";
import { InMemoryTrustRegistry, ProjectMutex, RULES, RuleTablePolicy, createComposerRunsHandlers, createComposerService } from "../src/index.js";
import { newKey } from "./approvals-rig.js";
import { allEvents, composerRig, until, type ComposerRig } from "./composer-rig.js";

const RUNS = "axis.runs";

async function setup(t: TestContext, replies: Parameters<typeof composerRig>[0]["replies"]): Promise<{ c: ComposerRig; trust: InMemoryTrustRegistry }> {
  const trust = new InMemoryTrustRegistry();
  trust.set({ windowId: "win-1" }, true);
  const c = await composerRig({ replies, policy: new RuleTablePolicy(trust, RULES) });
  t.after(() => c.cleanup());
  mkdirSync(join(c.root, ".github"), { recursive: true });
  c.r.daemon.register(RUNS, 1, createComposerRunsHandlers({ service: c.service, journal: c.journal, mutex: new ProjectMutex() }));
  return { c, trust };
}

const start = (workspaceId: string, over: Record<string, unknown> = {}) => ({ workspaceId, mode: "edit", prompt: "go", providerId: "mock", modelId: "mock-model", ...over });

test("axis.runs: the user starts a run; get, list and events answer contract shapes; the window comes from the identity", async (t) => {
  const { c } = await setup(t, [{ kind: "tool_use", name: "write_file", input: { path: ".github/ci.yml", content: "x" } }, { kind: "text", text: "done" }]);
  const s = await c.user.call(RUNS, "start", start(c.workspaceId), newKey());
  assert.equal(s.ok, true, JSON.stringify(s.error));
  assert.ok(composerRunsMethods.start.response.safeParse(s.result).success);
  const runId = (s.result?.["run"] as { runId: string }).runId;
  await until(() => c.service.get(runId).awaitingApproval);
  // The approval went to the starting connection's window (win-1), not to anything the payload could name.
  const [challenge] = (await c.user.call("axis.approvals", "pending", {})).result?.["challenges"] as Challenge[];
  assert.ok(challenge);
  const got = await c.user.call(RUNS, "get", { runId });
  assert.equal((got.result?.["run"] as { awaitingApproval: boolean }).awaitingApproval, true);
  await c.user.call("axis.approvals", "resolve", { challengeId: challenge.challengeId, decision: "approve", digest: challenge.digest });
  await until(() => !c.service.get(runId).live);
  const list = await c.user.call(RUNS, "list", { workspaceId: c.workspaceId });
  assert.deepEqual((list.result?.["runs"] as Array<{ runId: string; state: string }>).map((r) => [r.runId, r.state]), [[runId, "REVIEWING"]]);
  const ev = await c.user.call(RUNS, "events", { runId, afterSeq: 0 });
  assert.equal(ev.ok, true, JSON.stringify(ev.error));
  assert.equal(ev.result?.["complete"], true);
  assert.deepEqual(ev.result?.["events"], allEvents(c, runId));
});

test("axis.runs: an agent connection is refused every method by policy; an untrusted window cannot start", async (t) => {
  const { c, trust } = await setup(t, [{ kind: "text", text: "x" }]);
  const agent = await c.r.connect("agent:composer.x#conn-4#win-1");
  for (const [method, payload] of [["start", start(c.workspaceId)], ["cancel", { runId: "r1" }], ["get", { runId: "r1" }], ["list", {}], ["events", { runId: "r1" }]] as const) {
    const res = await agent.call(RUNS, method, payload, method === "start" || method === "cancel" ? newKey() : undefined);
    assert.equal(res.error?.code, "E_POLICY_DENIED", method);
  }
  trust.set({ windowId: "win-1" }, false);
  const untrusted = await c.user.call(RUNS, "start", start(c.workspaceId), newKey());
  assert.equal(untrusted.error?.code, "E_POLICY_DENIED");
  assert.equal(c.journal.listRuns({ workspaceId: c.workspaceId }).length, 0, "nothing was created");
  assert.equal((await c.user.call(RUNS, "list", {})).ok, true, "reads do not need trust");
});

test("axis.runs: no path or command can ride along, and errors are closed (no id, no provider text)", async (t) => {
  const { c } = await setup(t, [{ kind: "text", text: "x" }]);
  for (const k of ["cwd", "command", "tools", "windowId", "apiKey"]) {
    const res = await c.user.call(RUNS, "start", start(c.workspaceId, { [k]: "x" }), newKey());
    assert.equal(res.error?.code, "E_INVALID_ARGUMENT", k);
  }
  const missing = "00000000-0000-4000-8000-0000000000aa";
  const unknown = await c.user.call(RUNS, "get", { runId: missing });
  assert.equal(unknown.error?.code, "E_NOT_FOUND");
  assert.equal(JSON.stringify(unknown.error).includes(missing), false);
  const model = await c.user.call(RUNS, "start", start(c.workspaceId, { modelId: "secret-model-name" }), newKey());
  assert.deepEqual([model.error?.code, model.error?.details?.["reason"]], ["E_NOT_FOUND", "model_unknown"]);
  assert.equal(JSON.stringify(model.error).includes("secret-model-name"), false);
});

test("kill and restart: the journal keeps RUNNING, recovery makes it BLOCKED, a queued run is cancelled, the worktree is intact", async (t) => {
  const { c } = await setup(t, [{ kind: "tool_use", name: "write_file", input: { path: ".github/ci.yml", content: "x" } }]);
  const s = await c.user.call(RUNS, "start", start(c.workspaceId), newKey());
  const runId = (s.result?.["run"] as { runId: string }).runId;
  await until(() => c.service.get(runId).awaitingApproval);
  // A queued composer run (created, never driven) and a queued CLI run that is not the composer's to touch.
  const queued = c.journal.createRun({ workspaceId: c.workspaceId, kind: "composer", createdBy: "user" }).value.id;
  const cli = c.journal.createRun({ workspaceId: c.workspaceId, kind: "cli", createdBy: "user" }).value.id;
  const transitions = c.journal.transitions("run", runId).length;
  // The process dies: the service stops and writes nothing more.
  c.service.dispose();
  await c.service.idle();
  assert.equal(c.journal.getRun(runId)?.state, "RUNNING");
  assert.equal(c.journal.transitions("run", runId).length, transitions, "nothing was written after the shutdown");
  // Restart: the journal recovers under the instance lock, then the composer's own startup step.
  const lockDir = mkdtempSync(join(tmpdir(), "axis-composer-lock-"));
  const lock = acquireInstanceLock(lockDir);
  t.after(() => (lock.release(), rmSync(lockDir, { recursive: true, force: true })));
  c.journal.recover(lock);
  const next = createComposerService({ redactor: new Redactor(), journal: c.journal, engine: c.agent, now: () => c.r.clock.now() });
  t.after(() => next.dispose());
  assert.equal(next.recover(), 1);
  const blocked = next.get(runId);
  // J2: what the run was started with, what it used and what it did come from the journal.
  assert.deepEqual([blocked.state, blocked.reason, blocked.live, blocked.mode, blocked.providerId, blocked.modelId], ["BLOCKED", "INTERRUPTED_BY_RESTART", false, "edit", "mock", "mock-model"]);
  assert.equal(blocked.usage?.requests, 1);
  assert.ok(composerRunsMethods.get.response.safeParse({ run: blocked }).success);
  const page = next.events(runId, 0, 10);
  assert.deepEqual([page.available, page.complete, page.events.map((e) => (e.type === "approval" ? `approval:${e.state}` : e.type))], [true, true, ["state", "request", "usage", "approval:requested"]]);
  assert.ok(composerRunsMethods.events.response.safeParse(page).success);
  assert.equal(page.events.some((e) => e.type === "approval" && e.state === "withdrawn"), false, "nothing was written after the shutdown");
  assert.deepEqual(next.events(queued, 0, 10), { events: [], nextSeq: 0, complete: true, available: false }, "a run with no record has no stored activity");
  assert.deepEqual([c.journal.getRun(queued)?.state, c.journal.getRun(queued)?.reason], ["CANCELLED", "INTERRUPTED_BY_RESTART"]);
  assert.equal(c.journal.getRun(cli)?.state, "QUEUED", "a CLI run is the run supervisor's");
  assert.equal(next.recover(), 0, "recovery converges");
  // Nothing re-ran and nothing was written: the approval never came.
  assert.equal(c.wire(), 1);
  assert.deepEqual(c.journal.listRuns({ states: ["RUNNING"] }), []);
  assert.equal(next.cancel(runId).state, "CANCELLED", "the user can dismiss the interrupted run");
});
