// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { Journal, lastTransitionId, transitionsSince } from "@axis/journal";
import { eventBodySchema } from "@axis/protocol";
import { EVENT_ROWS_PER_TICK, createEventSources } from "../src/events/sources.js";
import { TASKS_PAYLOAD_ALLOWLIST, createTasksService, type TaskCaller } from "../src/index.js";

// The `tasks` topic (`tasks-slice3.md` §6.7, `events.md` §4): an invalidation hint per project, carrying the project id
// only. Its source is the audit trail: every task write appends its `task.*` row, with the project id, in the write's own
// transaction, so a committed change always has its row and a rolled-back one never does. Mutants each case kills: no
// tasks source, history replayed at start, the quiet cursor not moved, a non-task or failed row counted, one hint per row
// instead of per project, the cursor set to the head instead of the last row read (rows past the per-tick bound lost).

const USER: TaskCaller = { kind: "user" };

function rig() {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db, { payloadAllowlist: { ...TASKS_PAYLOAD_ALLOWLIST, "other.write": ["projectId"] } });
  const journal = Journal.open(db, { audit });
  for (const id of ["p", "q", "late"]) journal.registerProject({ id, path: `/repo/${id}`, displayName: id, trusted: false, actor: "user" });
  const service = createTasksService({ journal, audit, random: { bytes: (n) => randomBytes(n) } });
  const published: Record<string, unknown>[] = [];
  const state = { subs: 1 };
  const sources = () =>
    createEventSources({
      hub: { publish: (body) => (published.push(body as Record<string, unknown>), true), get subscriptionCount() { return state.subs; }, windowsFor: () => new Set<string>() },
      journal: { transitionsSince: (a, n) => transitionsSince(db, a, n), lastTransitionId: () => lastTransitionId(db) },
      auditHead: () => audit.head()?.seq ?? 0,
      auditSince: (afterSeq, limit) => audit.list({ afterSeq, limit }),
      anchorStalled: () => false,
      pending: () => [],
      intervalMs: 0,
    });
  const tasks = () => published.filter((b) => b["topic"] === "tasks");
  const create = (projectId: string, title = "Fix it") => service.create(USER, { projectId, title, body: "x" }).task;
  return { db, audit, journal, service, published, state, sources, tasks, create };
}

test("TSK1 task writes after start become one hint per project, in first-change order; history is not replayed", () => {
  const r = rig();
  r.create("late");
  const s = r.sources();
  const q = r.create("q");
  const p = r.create("p");
  r.service.update(USER, { taskId: p.taskId, baseSeq: 1, title: "Fix it", body: "y" });
  r.service.setStatus({ taskId: q.taskId, status: "done" });
  r.service.link({ taskId: p.taskId, link: { kind: "pr", target: "7" } });
  s.tick();
  assert.deepEqual(r.tasks(), [{ topic: "tasks", projectId: "q" }, { topic: "tasks", projectId: "p" }], "kills one hint per row and the replay of `late`");
  for (const b of r.tasks()) assert.equal(eventBodySchema.safeParse(b).success, true);
  r.published.length = 0;
  s.tick();
  assert.deepEqual(r.tasks(), [], "each row once");
  r.service.delete({ taskId: q.taskId });
  s.tick();
  assert.deepEqual(r.tasks(), [{ topic: "tasks", projectId: "q" }], "a delete is a change");
});

test("TSK2 no hint for a non-task row, a failed row or a rolled-back write; no title or task id on the wire", () => {
  const r = rig();
  const s = r.sources();
  r.audit.append({ actor: "user", action: "other.write", target: "x", outcome: "success", payload: { projectId: "p" } });
  r.audit.append({ actor: "user", action: "task.update", target: "task:t1", outcome: "failure", payload: { projectId: "q" } });
  assert.throws(() => r.journal.tasks.transaction(() => {
    r.create("p", "ROLLED-BACK-TITLE");
    throw new Error("abort");
  }));
  s.tick();
  assert.deepEqual(r.tasks(), [], "kills counting a non-task or failed row");
  r.create("p", "TITLE-CANARY");
  s.tick();
  assert.deepEqual(r.tasks(), [{ topic: "tasks", projectId: "p" }]);
  assert.equal(JSON.stringify(r.published).includes("CANARY"), false);
  assert.equal(JSON.stringify(r.published).includes("ROLLED-BACK"), false);
});

test("TSK3 with nobody subscribed the cursor moves forward, so a later subscriber is not sent history", () => {
  const r = rig();
  const s = r.sources();
  r.state.subs = 0;
  r.create("p");
  s.tick();
  r.state.subs = 1;
  s.tick();
  assert.deepEqual(r.tasks(), [], "kills a quiet tick that leaves the cursor");
  r.create("q");
  s.tick();
  assert.deepEqual(r.tasks(), [{ topic: "tasks", projectId: "q" }]);
});

test("TSK4 at most the per-tick bound of rows is read; a row past it is read on the next tick, not skipped", () => {
  const r = rig();
  const s = r.sources();
  for (let i = 0; i < EVENT_ROWS_PER_TICK; i++) r.audit.append({ actor: "user", action: "other.write", target: "x", outcome: "success", payload: { projectId: "p" } });
  r.create("late");
  s.tick();
  assert.deepEqual(r.tasks(), [], "the task row is past the bound");
  s.tick();
  assert.deepEqual(r.tasks(), [{ topic: "tasks", projectId: "late" }], "kills a cursor set to the head instead of the last row read");
});
