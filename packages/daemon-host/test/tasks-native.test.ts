// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { Journal } from "@axis/journal";
import { createTaskStart, createTasksContentHooks, createTasksHandlers, createTasksService, type ComposerStart } from "../src/index.js";
import { challengeOf, newKey, type Client, type Rig } from "./approvals-rig.js";
import { resolve, setup as rigSetup, waitFor } from "./approvals-helpers.js";

// PV-T1 slice 2b: Start and delete through the real approvals gate. Main's native dialog names the task by id, revision,
// the trust of its text and the worker, never its title or body; the renderer's own resolve never releases a Start; a task
// changed after the dialog refuses the approval.

const C = "axis.tasks";
const SHA = "b".repeat(40);

async function setup(t: TestContext) {
  const notes = new Map<string, string>();
  const { r, user } = await rigSetup(t, { describe: (_i, c) => notes.get(`${c.target}|${c.contentDigest}`) });
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  journal.registerProject({ id: "p", path: "/repo/p", displayName: "Shop", trusted: false, actor: "user" });
  const home = journal.transitionWorkspace(journal.createWorkspace({ projectId: "p", branch: "axis/p", baseRef: "main", baseSha: SHA, createdBy: "user" }).value.id, "READY").id;
  journal.agents.create({ id: "w1", projectId: "p", name: "Planner", launch: { kind: "composer", connection: "conn", modelId: "m", mode: "agent" }, homeWorkspaceId: home, groupId: null });
  const service = createTasksService({ journal, audit: { append: () => undefined }, random: { bytes: (n) => randomBytes(n) } });
  const starts: ComposerStart[] = [];
  const start = createTaskStart({
    journal,
    audit: { append: () => undefined },
    agentStart: { journal, startCli: async () => assert.fail("no CLI"), startComposer: async (req) => (starts.push(req), req.recheck?.(), { run: { runId: journal.composer.createRun({ workspaceId: req.workspaceId, createdBy: "user" }, { mode: "agent", providerId: "mock", modelId: "mock-model" }).value.id }, replayed: false }), providerFor: () => "mock" },
  });
  r.daemon.register(C, 1, createTasksHandlers(service, start), { content: createTasksContentHooks({ journal, onPreview: (target, digest, text) => void notes.set(`${target}|${digest}`, text) }) });
  const taskId = service.create({ kind: "user" }, { projectId: "p", title: "Fix it", body: "x" }).task.taskId;
  service.update({ kind: "agent", agentId: "w2", projectId: "p", runId: "r0", receivedHop: 2 }, { taskId, baseSeq: 1, title: "TITLE-CANARY says safe", body: "BODY-CANARY" });
  return { r, user, service, start, starts, taskId };
}

async function challenge(r: Rig, user: Client, method: string, payload: Record<string, unknown>, key: string) {
  const first = await user.call(C, method, payload, key);
  assert.equal(first.error?.code, "E_APPROVAL_REQUIRED", JSON.stringify(first.error));
  const c = challengeOf(first);
  await waitFor(() => r.nativeConfirms().some((m) => m["challengeId"] === c.challengeId), 60_000, "main was asked for its dialog");
  const sent = r.nativeConfirms().find((m) => m["challengeId"] === c.challengeId) as Record<string, unknown>;
  return { c, proof: String(sent["proof"]), summary: String(sent["summary"]) };
}
async function confirm(r: Rig, user: Client, ch: Awaited<ReturnType<typeof challenge>>): Promise<void> {
  const before = r.approvals.stats().native.confirmed;
  await resolve(user, ch.c);
  r.answer(ch.c.challengeId, ch.proof, true);
  await waitFor(() => r.approvals.stats().native.confirmed === before + 1, 60_000, "the dialog's answer was applied");
}
async function dismiss(r: Rig, ch: Awaited<ReturnType<typeof challenge>>): Promise<void> {
  const before = r.approvals.stats().native.refused;
  r.answer(ch.c.challengeId, ch.proof, false);
  await waitFor(() => r.approvals.stats().native.refused === before + 1, 60_000, "the dismissed dialog was applied");
}

test("Start needs main's dialog, which names the task, the trust of its text and the worker, never its title or body", async (t) => {
  const { r, user, service, start, starts, taskId } = await setup(t);
  const p = start.preview({ taskId, worker: "w1" });
  const payload = { taskId, worker: "w1", seq: p.seq, promptDigest: p.promptDigest };
  const k1 = newKey();
  const one = await challenge(r, user, "start", payload, k1);
  assert.deepEqual([one.c.tier, one.c.nativeConfirmationRequired], [4, true]);
  assert.equal(one.summary, `axis.tasks/1.start: UNTRUSTED (agent, hop 2): task ${taskId.slice(0, 12)}… r2 to Planner`);
  assert.equal(/CANARY|safe/.test(one.summary), false, "never the task's title or body");
  await resolve(user, one.c);
  assert.equal((await user.call(C, "start", { ...payload, approval: { challengeId: one.c.challengeId } }, k1)).ok, false, "a renderer-only resolve");
  assert.equal(starts.length, 0, "nothing started");
  await dismiss(r, one);
  const k2 = newKey();
  const two = await challenge(r, user, "start", payload, k2);
  await confirm(r, user, two);
  const done = await user.call(C, "start", { ...payload, approval: { challengeId: two.c.challengeId } }, k2);
  const runId = (done.result as { runId?: string } | undefined)?.runId;
  assert.deepEqual(done.result, { kind: "composer", runId, workspaceId: starts[0]?.workspaceId, replayed: false });
  assert.deepEqual(service.get({ taskId }).task.links, [{ kind: "run", target: runId }], "the confirmed Start linked its run");
  assert.equal(starts.length, 1);
  assert.equal(starts[0]?.prompt, p.prompt);
});

test("a task changed after main's dialog refuses the Start's approval; delete's dialog names the task and the project", async (t) => {
  const { r, user, service, start, starts, taskId } = await setup(t);
  const p = start.preview({ taskId, worker: "w1" });
  const payload = { taskId, worker: "w1", seq: p.seq, promptDigest: p.promptDigest };
  const key = newKey();
  const ch = await challenge(r, user, "start", payload, key);
  await confirm(r, user, ch);
  service.update({ kind: "user" }, { taskId, baseSeq: 2, title: "Fix it", body: "a third revision" });
  const late = await user.call(C, "start", { ...payload, approval: { challengeId: ch.c.challengeId } }, key);
  assert.equal(late.error?.code, "E_CONFLICT", JSON.stringify(late));
  assert.notEqual((late.error?.details as { reason?: string } | undefined)?.reason, "stale_version", "refused by the approval's binding, before the handler");
  assert.equal(starts.length, 0);
  const del = await challenge(r, user, "delete", { taskId }, newKey());
  assert.equal(del.summary, `axis.tasks/1.delete: task ${taskId}, all 3 revisions, in Shop`);
});

test("the Start line fits the dialog's own units and holds no character it would drop: emoji and bidi names, a long revision", async () => {
  const { taskContent, DIALOG_DETAIL_UNITS } = await import("../src/tasks/confirm.js");
  const { nativeSummary } = await import("../src/gate/summary.js");
  const at = "2026-01-01T00:00:00.000Z";
  const stub = (name: string, seq: number, author: Record<string, unknown>) => ({
    tasks: {
      get: () => ({ taskId: "t".padEnd(33, "a"), projectId: "p", source: "integration", status: "open", assignee: null, untrusted: true, hop: 8, lastSeq: seq, links: [], createdAt: at, updatedAt: at }),
      revision: () => ({ taskId: "t".padEnd(33, "a"), seq, title: "TITLE-CANARY", body: "BODY", author, hop: 8, createdAt: at }),
      revisions: () => [{ taskId: "t".padEnd(33, "a"), seq, title: "TITLE-CANARY", author, hop: 8, createdAt: at }],
    },
    agents: { get: () => ({ id: "w9", projectId: "p", name, archived: false, launch: { kind: "composer" } }) },
    getProject: () => undefined,
    getWorkspace: () => undefined,
  }) as never;
  const integration = { kind: "integration", integrationId: "jira" };
  for (const [what, name, seq] of [["an emoji name", "😀".repeat(64), 2], ["a long revision", "Planner of everything", 123_456_789_012], ["both", "😀".repeat(64), 123_456_789_012], ["few emoji, many units", "😀".repeat(10), 123_456_789_012]] as const) {
    const line = taskContent(stub(name, seq, integration), "start", { taskId: "t".padEnd(33, "a"), worker: "w9" }).text as string;
    assert.ok(line.length <= DIALOG_DETAIL_UNITS, `${what}: ${line.length} units`);
    assert.ok(line.startsWith(`UNTRUSTED (integration, hop 8): task ${"t".padEnd(12, "a")}… r${seq} to `), `${what}: ${line}`);
    assert.equal(nativeSummary("axis.tasks/1.start", "task:x", line), `axis.tasks/1.start: ${line}`, `${what}: shown whole, never cut in the middle`);
    assert.equal(line.includes("CANARY"), false);
  }
  const bidi = taskContent(stub("\u202eevil\u200b", 3, integration), "start", { taskId: "t".padEnd(33, "a"), worker: "w9" }).text as string;
  assert.ok(bidi.endsWith(" to ?evil?"), bidi);
  assert.equal(nativeSummary("axis.tasks/1.start", "task:x", bidi), `axis.tasks/1.start: ${bidi}`, "the dialog keeps the line, marker included");
});
