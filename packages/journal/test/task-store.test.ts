// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase, type DatabaseSync } from "@axis/audit";
import { Journal, TASK_LIMITS, type TaskAuthor } from "../src/index.js";

// The tasks store (ticket PV-T1 slice 1): Journal.tasks derives a task's trust itself, so no caller can store a task as
// more trusted than it is; refusals carry a closed reason. The table rules are migration-v15.test.ts.

const T = "2026-11-22T00:00:00.000Z";
const SHA = "b".repeat(40);
const USER: TaskAuthor = { kind: "user" };
const AGENT: TaskAuthor = { kind: "agent", agentId: "w1", hop: 2 };

function setup(): { db: DatabaseSync; journal: Journal; ws: string } {
  let tick = 0;
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db), now: () => new Date(Date.parse(T) + 1000 * tick++) });
  journal.registerProject({ id: "p1", path: "/repo/one", displayName: "One", trusted: false, actor: "user" });
  journal.registerProject({ id: "p2", path: "/repo/two", displayName: "Two", trusted: false, actor: "user" });
  const w = journal.createWorkspace({ projectId: "p1", branch: "axis/a", baseRef: "main", baseSha: SHA, createdBy: "user" }).value;
  const ws = journal.transitionWorkspace(w.id, "READY").id;
  journal.agents.createGroup({ id: "g1", projectId: "p1", name: "Backend" });
  journal.agents.create({ id: "w1", projectId: "p1", name: "Planner", launch: { kind: "cli", entryId: "my-cli" }, homeWorkspaceId: ws, groupId: null });
  return { db, journal, ws };
}
const reason = (f: () => unknown, code: string, why: string): void =>
  assert.throws(f, (e: unknown) => (e as { code?: string }).code === code && (e as { detail?: { reason?: string } }).detail?.reason === why, `${code} ${why}`);

test("create, update and read: revisions count up, a user task is trusted, the newest revision is current", () => {
  const { journal } = setup();
  const t = journal.tasks.create({ taskId: "t1", projectId: "p1", title: "Fix login", body: "steps", author: USER });
  assert.deepEqual([t.source, t.status, t.assignee, t.untrusted, t.hop, t.lastSeq, t.links], ["user", "open", null, false, 0, 1, []]);
  journal.tasks.update({ taskId: "t1", baseSeq: 1, title: "Fix login", body: "more steps", author: USER });
  assert.equal(journal.tasks.revision("t1")?.body, "more steps");
  assert.equal(journal.tasks.revision("t1", 1)?.body, "steps");
  assert.equal(journal.tasks.revision("t1", 9), undefined);
  assert.deepEqual(journal.tasks.revisions("t1").map((r) => r.seq), [2, 1]);
  assert.equal("body" in (journal.tasks.revisions("t1")[0] as object), false);
  assert.deepEqual(journal.tasks.list("p1").map((x) => x.taskId), ["t1"]);
  assert.deepEqual(journal.tasks.list("p2"), []);
});

test("a task from anyone but the user, or edited by anyone but the user, is untrusted for good, with the highest hop", () => {
  const { journal } = setup();
  const a = journal.tasks.create({ taskId: "ta", projectId: "p1", title: "Imported", body: "issue text", author: { kind: "integration", integrationId: "github", hop: 1 } });
  assert.deepEqual([a.source, a.untrusted, a.hop], ["integration", true, 1]);
  journal.tasks.create({ taskId: "tu", projectId: "p1", title: "Mine", body: "x", author: USER });
  const edited = journal.tasks.update({ taskId: "tu", baseSeq: 1, title: "Mine", body: "agent text", author: AGENT });
  assert.deepEqual([edited.untrusted, edited.hop], [true, 2]);
  const again = journal.tasks.update({ taskId: "tu", baseSeq: 2, title: "Mine", body: "rewritten by me", author: USER });
  assert.deepEqual([again.untrusted, again.hop], [true, 2], "a later user edit does not clear it");
  assert.equal(journal.tasks.update({ taskId: "tu", baseSeq: 3, title: "Mine", body: "x", author: { kind: "system", hop: 0 } }).untrusted, true);
});

test("status, assignee and links change the task in place; refusals are closed", () => {
  const { journal, ws } = setup();
  journal.tasks.create({ taskId: "t1", projectId: "p1", title: "A", body: "b", author: USER });
  assert.equal(journal.tasks.setStatus("t1", "in_progress").status, "in_progress");
  reason(() => journal.tasks.setStatus("t1", "started" as "open"), "E_INVALID_ARGUMENT", "status");
  assert.deepEqual(journal.tasks.assign("t1", { kind: "agent", id: "w1" }).assignee, { kind: "agent", id: "w1" });
  assert.deepEqual(journal.tasks.assign("t1", { kind: "group", id: "g1" }).assignee, { kind: "group", id: "g1" });
  reason(() => journal.tasks.assign("t1", { kind: "agent", id: "nope" }), "E_CONFLICT", "assignee_refused");
  reason(() => journal.tasks.assign("t1", { kind: "robot", id: "w1" } as unknown as null), "E_INVALID_ARGUMENT", "assignee");
  assert.equal(journal.tasks.assign("t1", null).assignee, null);
  assert.equal(journal.tasks.link("t1", { kind: "workspace", target: ws }), true);
  assert.equal(journal.tasks.link("t1", { kind: "workspace", target: ws }), false, "a link exists once");
  assert.equal(journal.tasks.link("t1", { kind: "pr", target: "7" }), true);
  reason(() => journal.tasks.link("t1", { kind: "page", target: "nope" }), "E_CONFLICT", "link_refused");
  reason(() => journal.tasks.link("t1", { kind: "url", target: "x" } as unknown as { kind: "pr"; target: string }), "E_INVALID_ARGUMENT", "link");
  assert.deepEqual(journal.tasks.get("t1")?.links.map((l) => l.kind).sort(), ["pr", "workspace"]);
  assert.equal(journal.tasks.unlink("t1", { kind: "pr", target: "7" }), true);
  assert.equal(journal.tasks.unlink("t1", { kind: "pr", target: "7" }), false);
  reason(() => journal.tasks.setStatus("nope", "done"), "E_NOT_FOUND", "not_found");
  assert.deepEqual(journal.tasks.list("p1", "done"), []);
  assert.equal(journal.tasks.list("p1", "in_progress").length, 1);
});

test("stale writes, sizes, authors and limits are refused with a closed reason; nothing of a refused create is kept", () => {
  const { db, journal } = setup();
  journal.tasks.create({ taskId: "t1", projectId: "p1", title: "A", body: "b", author: USER });
  reason(() => journal.tasks.update({ taskId: "t1", baseSeq: 0, title: "A", body: "c", author: USER }), "E_CONFLICT", "stale_version");
  reason(() => journal.tasks.update({ taskId: "nope", baseSeq: 1, title: "A", body: "c", author: USER }), "E_NOT_FOUND", "not_found");
  reason(() => journal.tasks.create({ taskId: "t1", projectId: "p1", title: "A", body: "b", author: USER }), "E_CONFLICT", "exists");
  reason(() => journal.tasks.create({ taskId: "t2", projectId: "p1", title: "A", body: "x".repeat(TASK_LIMITS.bodyChars + 1), author: USER }), "E_INVALID_ARGUMENT", "too_large");
  for (const author of [{ kind: "system", hop: 0 }, { kind: "admin" }, { kind: "agent", agentId: "w1", hop: 9 }, { kind: "plugin", hop: 1 }, null]) {
    reason(() => journal.tasks.create({ taskId: "t2", projectId: "p1", title: "A", body: "b", author: author as unknown as TaskAuthor & { kind: "user" } }), "E_INVALID_ARGUMENT", "author");
  }
  assert.throws(() => journal.tasks.create({ taskId: "t2", projectId: "p1", title: " A", body: "b", author: USER }), "the table refuses what the store does not check");
  assert.equal(journal.tasks.get("t2"), undefined);
  const stmt = db.prepare("INSERT INTO tasks (id, project_id, source, status, untrusted, hop, last_seq, created_at, updated_at) VALUES (?, 'p2', 'user', 'open', 0, 0, 0, ?, ?)");
  for (let i = 0; i < TASK_LIMITS.tasksPerProject; i++) stmt.run(`x${i}`, T, T);
  reason(() => journal.tasks.create({ taskId: "t3", projectId: "p2", title: "A", body: "b", author: USER }), "E_CONFLICT", "limit_reached");
  for (let i = 0; i < TASK_LIMITS.linksPerTask; i++) journal.tasks.link("t1", { kind: "pr", target: String(i + 1) });
  reason(() => journal.tasks.link("t1", { kind: "pr", target: "999" }), "E_CONFLICT", "limit_reached");
});

test("delete removes the task, its revisions and links", () => {
  const { journal } = setup();
  journal.tasks.create({ taskId: "t1", projectId: "p1", title: "A", body: "b", author: USER });
  journal.tasks.create({ taskId: "t2", projectId: "p1", title: "B", body: "b", author: AGENT });
  journal.tasks.link("t1", { kind: "pr", target: "1" });
  journal.tasks.delete("t1");
  assert.equal(journal.tasks.get("t1"), undefined);
  assert.equal(journal.tasks.revision("t1"), undefined);
  assert.deepEqual(journal.tasks.list("p1").map((t) => t.taskId), ["t2"]);
  reason(() => journal.tasks.delete("t1"), "E_NOT_FOUND", "not_found");
  reason(() => journal.tasks.revisions("t1"), "E_NOT_FOUND", "not_found");
});
