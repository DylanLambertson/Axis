// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase, runMigrations, schemaVersion, type DatabaseSync } from "@axis/audit";
import { JOURNAL_MIGRATIONS, JOURNAL_SCHEMA_VERSION, Journal, TASKS_KEEP_USER_MIGRATION, TASK_LIMITS, type TaskAuthor } from "../src/index.js";

// PV-T1 slice 3 (`docs/design/tasks-slice3.md` §3.2 and §4, RR-93): the cap of 50 revisions never evicts the user's newest
// revision. Each case names the mutant it kills: an eviction that ignores the author, pinning the user's OLDEST revision
// (`min` for `max`), `<>` for `IS NOT` (no pruning for a task with no user revision), and a loosened `kept` trigger.

const T = "2026-11-27T00:00:00.000Z";
const CAP = TASK_LIMITS.revisionsPerTask;
const USER: TaskAuthor = { kind: "user" };
const W: TaskAuthor = { kind: "agent", agentId: "w1", hop: 1 };
type Val = string | number | null;
const one = (db: DatabaseSync, sql: string, ...a: Val[]): Val => Object.values(db.prepare(sql).get(...a) as Record<string, Val>)[0] as Val;
const seqs = (db: DatabaseSync, task = "t1"): number[] => (db.prepare("SELECT seq FROM task_revisions WHERE task_id = ? ORDER BY seq").all(task) as { seq: number }[]).map((r) => r.seq);
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

function setup(): { db: DatabaseSync; journal: Journal } {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  journal.registerProject({ id: "p1", path: "/repo/one", displayName: "One", trusted: false, actor: "user" });
  return { db, journal };
}
/** Revisions `n` times by `author` on top of the newest, each with a distinct body. */
function revise(journal: Journal, n: number, author: TaskAuthor, task = "t1"): void {
  for (let i = 0; i < n; i++) {
    const seq = journal.tasks.get(task)?.lastSeq ?? 0;
    journal.tasks.update({ taskId: task, baseSeq: seq, title: "Fix it", body: `${author.kind} ${seq + 1}`, author });
  }
}
const refused = (f: () => void, what: string): void => assert.throws(f, Error, what);

test("one user revision, then 60 by a worker: the user's revision stays readable by seq; 50 in all; the oldest worker revisions went first", () => {
  const { db, journal } = setup();
  journal.tasks.create({ taskId: "t1", projectId: "p1", title: "Fix it", body: "the user's words", author: USER });
  revise(journal, 60, W);
  assert.deepEqual(seqs(db), [1, ...range(13, 61)], "kills the author-blind eviction (it would have dropped seq 1)");
  assert.equal(seqs(db).length, CAP);
  assert.equal(journal.tasks.revision("t1", 1)?.body, "the user's words");
  assert.deepEqual(journal.tasks.revision("t1", 1)?.author, USER);
  assert.equal(journal.tasks.revision("t1")?.seq, 61, "the newest is still current");
  assert.deepEqual([journal.tasks.get("t1")?.untrusted, journal.tasks.get("t1")?.hop], [true, 1], "the sticky flags are unchanged");
  db.close();
});

test("two user revisions separated by worker revisions, then 60 by a worker: the LATER user revision is kept, the earlier pruned in turn, exactly 50", () => {
  const { db, journal } = setup();
  journal.tasks.create({ taskId: "t1", projectId: "p1", title: "Fix it", body: "first", author: USER });
  revise(journal, 4, W); // 2..5
  revise(journal, 1, USER); // 6
  revise(journal, 60, W); // 7..66
  assert.deepEqual(seqs(db), [6, ...range(18, 66)], "kills pinning the user's oldest revision (min for max): seq 6 would be gone and seq 1 kept");
  assert.equal(journal.tasks.revision("t1", 1), undefined, "the earlier user revision was the oldest eligible");
  assert.equal(journal.tasks.revision("t1", 6)?.body, "user 6");
  db.close();
});

test("the 51st revision written by the user: the oldest other revision goes, the new one stays", () => {
  const { db, journal } = setup();
  journal.tasks.create({ taskId: "t1", projectId: "p1", title: "Fix it", body: "first", author: USER });
  revise(journal, CAP - 1, W); // 2..50
  revise(journal, 1, USER); // 51: the user's newest is the new row; seq 1 is no longer pinned
  assert.deepEqual(seqs(db), range(2, 51));
  db.close();
});

test("a task with no user revision is pruned to 50 as before (the NULL case)", () => {
  const { db, journal } = setup();
  journal.tasks.create({ taskId: "t1", projectId: "p1", title: "Fix it", body: "worker task", author: W });
  revise(journal, 60, W);
  assert.deepEqual(seqs(db), range(12, 61), "kills `<>` for `IS NOT`: comparing with NULL would match no row and stop pruning");
  db.close();
});

test("the kept trigger refuses any other deletion, a revision is never updated; deleting the task still removes every revision", () => {
  const { db, journal } = setup();
  journal.tasks.create({ taskId: "t1", projectId: "p1", title: "Fix it", body: "first", author: USER });
  revise(journal, 60, W);
  journal.tasks.create({ taskId: "t2", projectId: "p1", title: "Other", body: "x", author: W });
  refused(() => db.prepare("UPDATE task_revisions SET author_kind = 'user', author_id = NULL, hop = 0 WHERE task_id = 't1' AND seq = 61").run(), "a revision never changes: its author cannot be rewritten");
  for (const s of [1, 13, 40, 61]) refused(() => db.prepare("DELETE FROM task_revisions WHERE task_id = 't1' AND seq = ?").run(s), `seq ${s} at the cap`);
  refused(() => db.prepare("DELETE FROM task_revisions WHERE task_id = 't2'").run(), "a single revision under the cap");
  assert.equal(seqs(db).length, CAP);
  journal.tasks.delete("t1");
  assert.equal(one(db, "SELECT count(*) FROM task_revisions WHERE task_id = 't1'"), 0);
  assert.deepEqual(seqs(db, "t2"), [1], "another task's revisions are untouched");
  db.close();
});

test("a populated version 18 journal: both triggers replaced, the data unchanged, the rules hold on the migrated task", () => {
  const db = openDatabase(":memory:");
  new AuditLog(db);
  const version = TASKS_KEEP_USER_MIGRATION.version;
  runMigrations(db, "journal", JOURNAL_MIGRATIONS.slice(0, version - 1));
  assert.equal(schemaVersion(db, "journal"), version - 1);
  db.prepare("INSERT INTO projects (id, path, display_name, trusted, created_at, updated_at) VALUES ('p1', '/r1', 'One', 0, ?, ?)").run(T, T);
  db.prepare("INSERT INTO tasks (id, project_id, source, status, untrusted, hop, last_seq, created_at, updated_at) VALUES ('t1', 'p1', 'user', 'open', 0, 0, 0, ?, ?)").run(T, T);
  const put = (seq: number, kind: "user" | "agent"): void =>
    void db.prepare("INSERT INTO task_revisions (task_id, seq, title, body, bytes, author_kind, author_id, hop, created_at) VALUES ('t1', ?, 'Fix it', ?, ?, ?, ?, ?, ?)")
      .run(seq, `b${seq}`, 6 + `b${seq}`.length, kind, kind === "user" ? null : "w1", kind === "user" ? 0 : 1, T);
  put(1, "user");
  for (let s = 2; s <= 40; s++) put(s, "agent");
  const before = db.prepare("SELECT * FROM task_revisions ORDER BY seq").all();
  const triggers = (): string => (db.prepare("SELECT group_concat(sql, ';') AS s FROM sqlite_master WHERE type = 'trigger' AND name IN ('task_revisions_advance', 'task_revisions_kept')").get() as { s: string }).s;
  assert.equal(triggers().includes("author_kind = 'user'"), false, "version 18 has the old triggers");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  assert.equal((triggers().match(/author_kind = 'user'/g) ?? []).length, 2, "both triggers replaced");
  assert.deepEqual(db.prepare("SELECT * FROM task_revisions ORDER BY seq").all(), before, "no data changed");
  revise(journal, 20, W); // 41..60
  assert.deepEqual(seqs(db), [1, ...range(12, 60)], "the user's revision survives on the migrated task");
  db.close();
});
