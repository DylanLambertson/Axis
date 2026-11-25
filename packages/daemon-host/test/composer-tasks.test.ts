// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { CREATE_TASK, LIST_TASKS, READ_TASK, UPDATE_TASK, createTasksService, type TaskCaller, type TasksService } from "../src/index.js";
import { composerRig, type ComposerRig } from "./composer-rig.js";
import { approveAll, denyAll, drive, type DeliveryRig } from "./messages-delivery-rig.js";

// PV-T1 slice 2a: the task tools through the real broker, approvals and loop. `read_task` is IAC-T source 8; `list_tasks`
// shows no untrusted title; `create_task` and `update_task` ask the user once the run is tainted, with the text whole.

const USER: TaskCaller = { kind: "user" };
const worker = (agentId: string, receivedHop = 0, projectId = "p"): TaskCaller => ({ kind: "agent", agentId, projectId, runId: "r-other", receivedHop });

async function tasksRig(t: TestContext) {
  const holder: { svc?: TasksService } = {};
  const workers = new Map<string, { agentId: string; projectId: string }>();
  const lazy = new Proxy({} as TasksService, { get: (_t, k) => (holder.svc as unknown as Record<string | symbol, unknown>)[k] });
  const c: ComposerRig = await composerRig({ replies: [], tasks: { service: lazy, workerOf: (id) => workers.get(id) } });
  t.after(() => c.cleanup());
  for (const id of ["p", "q"]) if (c.journal.getProject(id) === undefined) c.journal.registerProject({ id, path: `/repo/${id}`, displayName: id, trusted: false, actor: "user" });
  const svc = createTasksService({ journal: c.journal, audit: c.audit, random: { bytes: (n) => randomBytes(n) } });
  holder.svc = svc;
  return {
    c,
    r: { c } as unknown as DeliveryRig,
    svc,
    run(agentId?: string, projectId = "p"): string {
      const id = c.journal.composer.createRun({ workspaceId: c.workspaceId, createdBy: "user" }, { mode: "agent", providerId: "mock", modelId: "mock-model" }).value.id;
      c.journal.transitionRun(id, "RUNNING");
      if (agentId !== undefined) workers.set(id, { agentId, projectId });
      return id;
    },
    drop: (runId: string) => void workers.delete(runId),
    rows: (action: string) => c.audit.list({ limit: 2000 }).filter((e) => e.action === action).map((e) => e.payload as Record<string, unknown>),
  };
}
const task = (svc: TasksService, title = "Fix it", body = "user text", projectId = "p") => svc.create(USER, { projectId, title, body }).task;
const call = (name: string, input: Record<string, unknown>) => ({ name, input });

test("read_task of a worker's task taints the run before the text returns: a write in the SAME reply asks the user, written at the read's hop", async (t) => {
  const p = await tasksRig(t);
  const tk = task(p.svc);
  p.svc.update(worker("w2", 3), { taskId: tk.taskId, baseSeq: 1, title: "Fix it", body: "worker text" });
  const runId = p.run("w1");
  const d = drive(p.r, runId, [[call(READ_TASK, { taskId: tk.taskId }), call(CREATE_TASK, { title: "Follow up", body: "next" })], []]);
  assert.equal((await Promise.all([approveAll(p.r, d.end), d.end]))[0], 1, "the create waited for the user");
  assert.equal(p.c.journal.composer.tainted(runId), true);
  assert.deepEqual(p.rows("message.taint").map((x) => [x["source"], x["sourceId"], x["senderKind"], x["hop"]]), [["task_read", `${tk.taskId}:2`, "agent", 3]]);
  const card = d.notes.find((n) => n.state === "requested");
  assert.deepEqual(card?.preview?.taint?.sources.map((x) => [x.source, x.sender, x.hop]), [["task_read", "w2", 3]]);
  assert.equal(card?.preview?.content?.head, "New task: Follow up\n\nnext");
  const mine = p.svc.list({ projectId: "p" }).tasks.find((x) => x.title === "Follow up");
  assert.deepEqual([mine?.source, mine?.untrusted, mine?.hop], ["agent", true, 3], "the worker's task, at the hop it received");
  assert.match(d.results[1]?.[0] ?? "", /^\[axis-task [0-9a-f]{24}\] Task .*may hold text the user did not write[\s\S]*\n\| worker text\n/);
});

test("a task only the user wrote taints nothing, and an untainted run creates and updates without asking", async (t) => {
  const p = await tasksRig(t);
  const tk = task(p.svc);
  const runId = p.run("w1");
  const d = drive(p.r, runId, [[call(READ_TASK, { taskId: tk.taskId })], [call(UPDATE_TASK, { taskId: tk.taskId, baseSeq: 1, title: "Fix it", body: "user text\nmore" }), call(CREATE_TASK, { title: "New", body: "x" })], []]);
  assert.equal(await denyAll(p.r, d.end), 0, "nothing was put to the user");
  assert.equal(p.c.journal.composer.tainted(runId), false);
  assert.deepEqual(p.rows("message.taint"), []);
  assert.deepEqual(d.results[2], [`wrote task ${tk.taskId}, revision 2`, d.results[2]?.[1]]);
  assert.match(d.results[2]?.[1] ?? "", /^created task t[0-9a-f]{32}, revision 1$/);
  const now = p.svc.get({ taskId: tk.taskId });
  assert.deepEqual([now.task.untrusted, now.revision.meta.author], [true, { kind: "agent", agentId: "w1" }], "the worker's revision makes the task untrusted");
  assert.deepEqual(p.rows("task.update").map((x) => [x["callerKind"], x["authorKind"], x["runId"]]), [["agent", "agent", runId]]);
});

test("list_tasks shows an untrusted task's id, status and flag, never its title, and takes no receipt", async (t) => {
  const p = await tasksRig(t);
  const mine = task(p.svc, "USER-TITLE");
  const theirs = p.svc.create(worker("w2", 1), { projectId: "p", title: "WORKER-TITLE", body: "x" }).task;
  task(p.svc, "OTHER-PROJECT", "x", "q");
  const runId = p.run("w1");
  const d = drive(p.r, runId, [[call(LIST_TASKS, {})], []]);
  await d.end;
  const out = d.results[1]?.[0] ?? "";
  assert.ok(out.includes(`${mine.taskId} [open] USER-TITLE`), out);
  assert.ok(out.includes(`${theirs.taskId} [open] (untrusted: title hidden`), out);
  assert.equal(out.includes("WORKER-TITLE"), false, "no untrusted title");
  assert.equal(out.includes("OTHER-PROJECT"), false, "only the worker's project");
  assert.equal(p.c.journal.composer.tainted(runId), false);
});

test("in a tainted run: an update the card cannot show whole is refused before any card; a denied one writes nothing", async (t) => {
  const p = await tasksRig(t);
  const tk = task(p.svc);
  p.svc.update(worker("w2", 1), { taskId: tk.taskId, baseSeq: 1, title: "Fix it", body: "worker" });
  const runId = p.run("w1");
  const d = drive(p.r, runId, [[call(READ_TASK, { taskId: tk.taskId })], [call(UPDATE_TASK, { taskId: tk.taskId, baseSeq: 2, title: "Fix it", body: "z".repeat(3000) })], [call(UPDATE_TASK, { taskId: tk.taskId, baseSeq: 2, title: "Fixed", body: "worker\nok" })], []]);
  assert.equal(await denyAll(p.r, d.end), 1, "only the reviewable one reached the user");
  await d.end;
  assert.match(d.results[2]?.[0] ?? "", /^The call was refused \(content_not_reviewable\)\./);
  const card = d.notes.find((n) => n.state === "requested");
  assert.equal(card?.preview?.content?.head, `Task: ${tk.taskId} (edits revision 2)\nTitle: Fix it -> Fixed\n\n@@ line 2: -0 +1\n+ ok`);
  assert.equal(p.svc.get({ taskId: tk.taskId }).task.lastSeq, 2, "nothing written");
});

test("the task tools: only for a run with a live worker, scoped to its project, lost at the next call once the worker is archived", async (t) => {
  const p = await tasksRig(t);
  const without = p.run();
  const d0 = drive(p.r, without, [[call(LIST_TASKS, {})], []]);
  await d0.end;
  assert.equal(d0.tools[0]?.includes(READ_TASK), false);
  assert.match(d0.results[1]?.[0] ?? "", /unknown/);
  const other = task(p.svc, "Q", "x", "q");
  const runId = p.run("w1");
  const d = drive(p.r, runId, [[call(READ_TASK, { taskId: other.taskId }), call(READ_TASK, { taskId: "tnope" })], [call(LIST_TASKS, {})], []], { onTurn: (n) => (n === 1 ? p.drop(runId) : undefined) });
  await d.end;
  for (const tool of [READ_TASK, LIST_TASKS, CREATE_TASK, UPDATE_TASK]) assert.ok(d.tools[0]?.includes(tool), tool);
  assert.deepEqual(d.results[1]?.map((x) => x.split(".")[0]), ["The call was refused (not_found)", "The call was refused (not_found)"], "another project's task is unknown");
  assert.match(d.results[2]?.[0] ?? "", /^The call was refused \(not_found\)/, "archived: refused");
});
