// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { Journal, lastTransitionId, transitionsSince } from "@axis/journal";
import { eventBodySchema } from "@axis/protocol";
import { EVENT_ROWS_PER_TICK, createEventSources } from "../src/events/sources.js";
import type { HandlerContext } from "@axis/daemon";
import { TASKS_PAYLOAD_ALLOWLIST, createTaskStart, createTasksService, type TaskCaller } from "../src/index.js";

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
  /** `tasks`: the windows subscribed to the topic. `broken`: the audit read throws (a malformed row). */
  const state = { subs: 1, tasks: new Set(["w1"]), broken: false, reads: 0, errors: [] as string[] };
  const sources = () =>
    createEventSources({
      hub: {
        publish: (body) => (published.push(body as Record<string, unknown>), true),
        get subscriptionCount() { return state.subs; },
        windowsFor: (topic) => new Set(topic === "tasks" ? state.tasks : []),
      },
      journal: { transitionsSince: (a, n) => transitionsSince(db, a, n), lastTransitionId: () => lastTransitionId(db) },
      auditHead: () => audit.head()?.seq ?? 0,
      auditSince: (afterSeq, limit) => {
        state.reads++;
        if (state.broken) throw new Error("Audit row is malformed; run verify()");
        return audit.list({ afterSeq, limit });
      },
      anchorStalled: () => false,
      pending: () => [],
      intervalMs: 0,
      onError: (reason) => void state.errors.push(reason),
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

// Review 1 of the tasks topic: N1 (a row the audit log cannot read stops the source; it is reported once per stuck
// position, not every tick), N2 (no audit read when nobody subscribes to tasks or nothing was appended), N3 (Start,
// assign and unlink hint too). Mutants: a log every tick, skipping the unreadable rows, reading with no tasks subscriber,
// reading at the head, a Start row that is not `TASK_AUDIT.start`.

test("TSK5 a row the audit log cannot read stops the tasks source and is reported once per stuck position; nothing is skipped", () => {
  const r = rig();
  const s = r.sources();
  r.state.broken = true;
  r.create("p");
  for (let i = 0; i < 5; i++) s.tick();
  assert.deepEqual(r.state.errors, ["events_source"], "kills a log every tick");
  assert.deepEqual(r.tasks(), []);
  r.state.broken = false;
  r.create("q");
  s.tick();
  assert.deepEqual(r.tasks(), [{ topic: "tasks", projectId: "p" }, { topic: "tasks", projectId: "q" }], "kills skipping: the change at the stuck position is still hinted");
  r.state.broken = true;
  r.create("p");
  s.tick();
  s.tick();
  assert.deepEqual(r.state.errors, ["events_source", "events_source"], "a new stuck position is reported again, once");
});

test("TSK6 no audit read when nobody subscribes to tasks, or when nothing was appended; a later tasks subscriber is not sent history", () => {
  const r = rig();
  const s = r.sources();
  r.state.tasks = new Set();
  r.create("p");
  s.tick();
  s.tick();
  assert.equal(r.state.reads, 0, "kills reading with only other topics subscribed");
  r.state.tasks = new Set(["w1"]);
  s.tick();
  assert.deepEqual([r.tasks(), r.state.reads], [[], 0], "the cursor moved while nobody subscribed to tasks, and nothing was appended since: kills reading at the head");
  r.create("q");
  s.tick();
  assert.deepEqual([r.tasks(), r.state.reads], [[{ topic: "tasks", projectId: "q" }], 1]);
});

test("TSK7 a Start, an assignment and an unlink are changes too", async () => {
  const r = rig();
  const t = r.create("p");
  const ws = r.journal.transitionWorkspace(r.journal.createWorkspace({ projectId: "p", branch: "axis/p", baseRef: "main", baseSha: "b".repeat(40), createdBy: "user" }).value.id, "READY").id;
  r.journal.agents.create({ id: "c1", projectId: "p", name: "Shell", launch: { kind: "cli", entryId: "my-cli" }, homeWorkspaceId: ws, groupId: null });
  const start = createTaskStart({ journal: r.journal, audit: r.audit, agentStart: { journal: r.journal, startCli: async () => assert.fail("no run"), startComposer: async () => assert.fail("no run"), providerFor: () => "mock" } });
  const s = r.sources();
  const ctx = { identity: { actor: "user", clientKind: "desktop" }, signal: new AbortController().signal } as unknown as HandlerContext;
  await start.start({ taskId: t.taskId, worker: "c1", seq: 1, promptDigest: start.preview({ taskId: t.taskId, worker: "c1" }).promptDigest }, ctx);
  s.tick();
  assert.deepEqual(r.tasks(), [{ topic: "tasks", projectId: "p" }], "a Start (kills a Start row that is not TASK_AUDIT.start)");
  for (const write of [() => r.service.assign({ taskId: t.taskId, assignee: { kind: "agent", id: "c1" } }), () => r.service.unlink({ taskId: t.taskId, link: { kind: "pr", target: "7" } })]) {
    r.published.length = 0;
    write();
    s.tick();
    assert.deepEqual(r.tasks(), [{ topic: "tasks", projectId: "p" }]);
  }
});
