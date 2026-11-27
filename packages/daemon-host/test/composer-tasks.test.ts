// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CREATE_TASK, LIST_TASKS, READ_TASK, UPDATE_TASK } from "../src/index.js";
import { approveAll, denyAll, drive } from "./messages-delivery-rig.js";
import { call, task, tasksRig, worker } from "./tasks-rig.js";

// PV-T1 slice 2a: the task tools through the real broker, approvals and loop. `read_task` is IAC-T source 8; `list_tasks`
// shows no untrusted title; `create_task` and `update_task` ask the user once the run is tainted, with the text whole.

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

test("a task only the user wrote taints nothing, and an untainted run creates without asking (updates: composer-tasks-guard)", async (t) => {
  const p = await tasksRig(t);
  const tk = task(p.svc);
  const runId = p.run("w1");
  const d = drive(p.r, runId, [[call(READ_TASK, { taskId: tk.taskId })], [call(CREATE_TASK, { title: "New", body: "x" })], []]);
  assert.equal(await denyAll(p.r, d.end), 0, "nothing was put to the user");
  assert.equal(p.c.journal.composer.tainted(runId), false);
  assert.deepEqual(p.rows("message.taint"), []);
  assert.match(d.results[2]?.[0] ?? "", /^created task t[0-9a-f]{32}, revision 1$/);
  const mine = p.svc.list({ projectId: "p" }).tasks.find((x) => x.title === "New");
  assert.deepEqual([mine?.source, mine?.untrusted], ["agent", true], "the worker's task is untrusted");
  assert.deepEqual(p.rows("task.create").filter((x) => x["callerKind"] === "agent").map((x) => [x["authorKind"], x["runId"]]), [["agent", runId]]);
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

test("review 2a F2: a task body with a NUL or a lone surrogate is a closed refusal before any card, and nothing is written", async (t) => {
  const p = await tasksRig(t);
  const tk = task(p.svc);
  const runId = p.run("w1");
  const bad = ["a\u0000b", "a\ud800b"];
  const d = drive(p.r, runId, [[call(CREATE_TASK, { title: "Bad", body: bad[0] ?? "" }), call(UPDATE_TASK, { taskId: tk.taskId, baseSeq: 1, title: "Fix it", body: bad[1] ?? "" })], []]);
  await d.end;
  const out = d.results[1] ?? [];
  assert.equal(out.length, 2, "both calls answered");
  for (const r of out) assert.match(r, /^The call was refused \(invalid_args\)\./, "the closed invalid_args refusal, not an open tool failure");
  assert.equal(p.svc.list({ projectId: "p" }).tasks.length, 1, "nothing was created");
  assert.equal(p.svc.get({ taskId: tk.taskId }).task.lastSeq, 1, "nothing was revised");
});
