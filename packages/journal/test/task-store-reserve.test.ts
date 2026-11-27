// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase, type DatabaseSync } from "@axis/audit";
import { Journal, TASK_LIMITS, TASK_USER_RESERVE, type TaskAuthor } from "../src/index.js";

// The user's reserve (`tasks-store.md` §4.1, RR-93 decision C1): any author but the user is refused `limit_reached` once the
// project holds 900 tasks, or once a write would bring its text past 64 MiB less a tenth; the user's own create and update
// still reach the full 1,000 tasks and 64 MiB. Mutants each case kills: the reserve on the user's create, on the user's
// update, the text reserve left out (count only), the reserve left out for an update, the hard cap gone for the user.

const T = "2026-11-27T00:00:00.000Z";
const USER: TaskAuthor = { kind: "user" };
const WORKER: TaskAuthor = { kind: "agent", agentId: "w1", hop: 1 };
const WORKER_TASKS = TASK_LIMITS.tasksPerProject - TASK_USER_RESERVE.tasks;
const WORKER_BYTES = TASK_LIMITS.projectBytes - TASK_USER_RESERVE.bytes;

function setup(): { db: DatabaseSync; journal: Journal } {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  journal.registerProject({ id: "p1", path: "/repo/one", displayName: "One", trusted: false, actor: "user" });
  return { db, journal };
}
const reason = (f: () => unknown, why: string, what: string): void =>
  assert.throws(f, (e: unknown) => (e as { detail?: { reason?: string } }).detail?.reason === why, what);
/** `bytes` of UTF-8 text in at most 16,384 characters (two-byte characters, then one ASCII one if odd). */
const text = (bytes: number): string => "é".repeat(Math.floor(bytes / 2)) + "x".repeat(bytes % 2);

test("the reserve on tasks: other authors stop at 900, the user goes on to 1,000, and the hard cap still holds for the user", () => {
  const { journal } = setup();
  assert.deepEqual([TASK_USER_RESERVE.tasks, WORKER_TASKS], [100, 900]);
  for (let i = 0; i < WORKER_TASKS - 1; i++) journal.tasks.create({ taskId: `u${i}`, projectId: "p1", title: "Fix it", body: "x", author: USER });
  journal.tasks.create({ taskId: "w-last", projectId: "p1", title: "Fix it", body: "x", author: WORKER });
  reason(() => journal.tasks.create({ taskId: "w-over", projectId: "p1", title: "Fix it", body: "x", author: WORKER }), "limit_reached", "a worker's 901st task");
  journal.tasks.update({ taskId: "w-last", baseSeq: 1, title: "Fix it", body: "y", author: WORKER });
  for (let i = WORKER_TASKS; i < TASK_LIMITS.tasksPerProject; i++) journal.tasks.create({ taskId: `u${i}`, projectId: "p1", title: "Fix it", body: "x", author: USER });
  assert.equal(journal.tasks.list("p1").length, 1_000, "kills the reserve applied to the user's create");
  reason(() => journal.tasks.create({ taskId: "u-over", projectId: "p1", title: "Fix it", body: "x", author: USER }), "limit_reached", "the user's 1,001st task");
});

test("the reserve on text: other authors stop at 64 MiB less a tenth, on create and update; the user's create and update go on", () => {
  const { db, journal } = setup();
  assert.equal(TASK_USER_RESERVE.bytes, 6_710_886);
  // Fill with raw rows (1,000 tasks of 50 revisions with 16,384-character bodies could not reach it by the store alone in a test).
  const body = text(2 * TASK_LIMITS.bodyChars);
  const per = 1 + Buffer.byteLength(body);
  const row = db.prepare("INSERT INTO task_revisions (task_id, seq, title, body, bytes, author_kind, author_id, hop, created_at) VALUES (?, ?, 'F', ?, ?, 'user', NULL, 0, ?)");
  let used = 0;
  for (let t = 0; used + per + 1_000 <= WORKER_BYTES; t++) {
    db.prepare("INSERT INTO tasks (id, project_id, source, status, untrusted, hop, last_seq, created_at, updated_at) VALUES (?, 'p1', 'user', 'open', 0, 0, 0, ?, ?)").run(`f${t}`, T, T);
    for (let s = 1; s <= TASK_LIMITS.revisionsPerTask && used + per + 1_000 <= WORKER_BYTES; s++, used += per) row.run(`f${t}`, s, body, per, T);
  }
  const left = WORKER_BYTES - used;
  assert.ok(left >= 1_000 && left < per + 1_000);
  journal.tasks.create({ taskId: "w1t", projectId: "p1", title: "x", body: text(999), author: WORKER });
  const room = left - 1_000; // what a worker may still write
  if (room > 0) journal.tasks.update({ taskId: "w1t", baseSeq: 1, title: "x", body: text(Math.max(0, room - 1)), author: WORKER });
  const seq = journal.tasks.get("w1t")?.lastSeq ?? 0;
  reason(() => journal.tasks.update({ taskId: "w1t", baseSeq: seq, title: "x", body: "y", author: WORKER }), "limit_reached", "a worker's update past the share (kills the reserve left out for an update)");
  reason(() => journal.tasks.create({ taskId: "w2t", projectId: "p1", title: "x", body: "", author: WORKER }), "limit_reached", "a worker's create past the share (kills a count-only reserve)");
  journal.tasks.create({ taskId: "u1t", projectId: "p1", title: "x", body: text(1_000), author: USER });
  journal.tasks.update({ taskId: "u1t", baseSeq: 1, title: "x", body: text(2_000), author: USER });
  assert.equal(journal.tasks.get("u1t")?.lastSeq, 2, "kills the reserve applied to the user's update");
});
