// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase, runMigrations, schemaVersion, type DatabaseSync } from "@axis/audit";
import { JOURNAL_MIGRATIONS, JOURNAL_SCHEMA_VERSION, Journal, type AppendMessage } from "../src/index.js";

// axis.messages/1 records (ticket PV-M3): schema version 9, forward-only, additive.

const V8 = JOURNAL_MIGRATIONS.slice(0, 8);
const id = (kind: "thr" | "msg", n: number): string => `${kind}_${String(n).padStart(21, "0")}A`;
const T1 = id("thr", 1);

function open(db: DatabaseSync = openDatabase(":memory:")): { db: DatabaseSync; journal: Journal } {
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  journal.registerProject({ id: "p1", path: "/repo/one", displayName: "One", trusted: true, actor: "user" });
  return { db, journal };
}
const post = (over: Partial<AppendMessage> & { n: number; thread?: AppendMessage["thread"] }): AppendMessage => ({
  thread: over.thread ?? { create: false, id: T1 },
  join: over.join ?? [],
  message: { id: id("msg", over.n), sender: { kind: "user", verified: true }, senderKey: "user", recipients: [{ agent: "a1" }], expanded: [{ kind: "agent", agentId: "a1" }], body: `hello ${over.n}`, refs: [], inReplyTo: null, hop: 0 },
  to: over.to ?? [{ principal: "agent:a1", counted: false }],
});
const first = (): AppendMessage => post({ n: 1, thread: { create: true, id: T1, projectId: "p1" }, join: ["user", "agent:a1"] });

test("version 9: a new thread, its participants and messages; seq only grows; the thread's last seq follows", () => {
  const { db, journal } = open();
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  assert.ok(JOURNAL_SCHEMA_VERSION >= 9);
  const m = journal.messages;
  const a = m.append(first());
  assert.deepEqual([a.seq, a.threadId, a.body, a.hop, a.inReplyTo], [1, T1, "hello 1", 0, null]);
  m.append(post({ n: 2, join: ["agent:a2"], to: [{ principal: "agent:a2", counted: false }] }));
  assert.equal(m.thread(T1)?.lastSeq, 2);
  assert.deepEqual(m.participants(T1), [{ principal: "user", joinedSeq: 0 }, { principal: "agent:a1", joinedSeq: 0 }, { principal: "agent:a2", joinedSeq: 1 }]);
  // a2 joined after message 1 and was not addressed by it: it reads only message 2.
  assert.deepEqual(m.visibleAfter(T1, "agent:a2", 1, 0, 10).map((x) => x.seq), [2]);
  assert.deepEqual(m.visibleAfter(T1, "user", 0, 0, 10).map((x) => x.seq), [1, 2]);
  assert.equal(m.visible(id("msg", 1), "agent:a2", 1), false);
  assert.equal(m.visible(id("msg", 2), "agent:a2", 1), true);
  db.close();
});

test("version 9: a message is never changed, a seq cannot be skipped or reused, a participant never changes, a cursor never moves back", () => {
  const { db, journal } = open();
  const m = journal.messages;
  m.append(first());
  assert.throws(() => db.prepare("UPDATE agent_messages SET body = 'changed'").run(), /never changed/);
  assert.throws(() => db.prepare("INSERT INTO agent_messages (id, thread_id, seq, sender, sender_key, recipients, expanded, body, refs, hop, created_at) VALUES (?, ?, 5, '{}', 'user', '[]', '[]', 'x', '[]', 0, 't')").run(id("msg", 9), T1), /next sequence/);
  assert.throws(() => db.prepare("UPDATE message_participants SET joined_seq = 0").run(), /only joins/);
  assert.throws(() => db.prepare("UPDATE message_threads SET project_id = 'p2'").run(), /keeps its id and project/);
  assert.throws(() => db.prepare("UPDATE message_threads SET last_seq = 0").run(), /only grows/);
  assert.equal(m.markRead(T1, "agent:a1", 1), 1);
  assert.equal(m.markRead(T1, "agent:a1", 0), 1, "a lower cursor is ignored");
  assert.throws(() => db.prepare("UPDATE message_cursors SET read_through = 0").run(), /never moves back/);
  // hop above the cap, a bad id shape and a thread of an unknown project are refused by the table.
  assert.throws(() => m.append({ ...post({ n: 3 }), message: { ...post({ n: 3 }).message, hop: 9 } }));
  assert.throws(() => m.append({ ...post({ n: 4 }), message: { ...post({ n: 4 }).message, id: "msg_short" } }));
  assert.throws(() => m.append(post({ n: 5, thread: { create: true, id: id("thr", 2), projectId: "nope" } })));
  assert.equal(m.thread(T1)?.lastSeq, 1, "nothing of a refused append is kept");
  assert.equal(m.thread(id("thr", 2)), undefined);
  db.close();
});

test("version 9: a thread holds at most 64 participants", () => {
  const { db, journal } = open();
  const m = journal.messages;
  m.append(post({ n: 1, thread: { create: true, id: T1, projectId: "p1" }, join: Array.from({ length: 64 }, (_, i) => `agent:a${i}`) }));
  assert.throws(() => m.append(post({ n: 2, join: ["agent:extra"] })));
  assert.equal(m.participants(T1).length, 64);
  db.close();
});

test("version 9: unread, queue counts and the inbox follow the cursor; a principal's text is a bound value, never SQL", () => {
  const { db, journal } = open();
  const m = journal.messages;
  m.append(first());
  m.append({ ...post({ n: 2 }), message: { ...post({ n: 2 }).message, senderKey: "agent:a2" }, to: [{ principal: "agent:a1", counted: true }] });
  m.append({ ...post({ n: 3 }), message: { ...post({ n: 3 }).message, senderKey: "agent:a2" }, to: [{ principal: "agent:a1", counted: true }] });
  assert.equal(m.unread(T1, "agent:a1"), 3);
  assert.equal(m.queued("agent:a1"), 2, "the user's message does not count against the queue");
  assert.equal(m.queued("agent:a1", "agent:a2"), 2);
  assert.equal(m.queued("agent:a1", "agent:a3"), 0);
  assert.deepEqual(m.inbox("agent:a1", { limit: 10 }).map((x) => x.seq), [1, 2, 3]);
  m.markRead(T1, "agent:a1", 2);
  assert.deepEqual([m.unread(T1, "agent:a1"), m.queued("agent:a1")], [1, 1]);
  assert.deepEqual(m.inbox("agent:a1", { threadId: T1, afterSeq: 0, limit: 10 }).map((x) => x.seq), [3]);
  for (const hostile of ["agent:a1' OR '1'='1", "user\" --", "agent:a1%", "*"]) {
    assert.deepEqual(m.inbox(hostile, { limit: 10 }), []);
    assert.deepEqual(m.threads({ principal: hostile, limit: 10 }), []);
    assert.equal(m.participant(T1, hostile), undefined);
  }
  assert.deepEqual(m.threads({ principal: "agent:a1", limit: 10 }).map((t) => t.id), [T1]);
  assert.deepEqual(m.threads({ projectId: "p1' OR 1=1 --", limit: 10 }), []);
  assert.throws(() => m.inbox("agent:a1", { limit: 0 }));
  db.close();
});

test("upgrading a version 8 database keeps every earlier record and adds the message tables", () => {
  const db = openDatabase(":memory:");
  runMigrations(db, "journal", V8);
  db.prepare("INSERT INTO projects (id, path, display_name, trusted, created_at, updated_at) VALUES ('p1', '/repo/one', 'One', 1, 't', 't')").run();
  db.prepare("INSERT INTO agent_workspaces (id, project_id, branch, base_ref, base_sha, created_by, state, created_at, updated_at) VALUES ('w1', 'p1', 'axis/old', 'HEAD', ?, 'user', 'READY', 't', 't')").run("c".repeat(40));
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  assert.equal(journal.getWorkspace("w1")?.projectId, "p1");
  journal.messages.append(first());
  const again = Journal.open(db, { audit: new AuditLog(db) });
  assert.equal(again.messages.thread(T1)?.lastSeq, 1, "a message survives reopening");
  db.close();
});

test("a version 9 upgrade that fails part way leaves version 8 exactly as it was", () => {
  const db = openDatabase(":memory:");
  runMigrations(db, "journal", V8);
  const schemaOf = (): unknown[] => (db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all() as unknown[]).map((r) => ({ ...(r as object) }));
  const before = schemaOf();
  const v9 = JOURNAL_MIGRATIONS[8];
  assert.ok(v9 !== undefined && v9.version === 9);
  assert.throws(() => runMigrations(db, "journal", [...V8, { version: 9, sql: `${v9.sql}; INSERT INTO message_threads (id) VALUES (NULL);` }]));
  assert.equal(db.isTransaction, false);
  assert.equal(schemaVersion(db, "journal"), 8);
  assert.deepEqual(schemaOf(), before, "no table, index or trigger left behind");
  Journal.open(db, { audit: new AuditLog(db) });
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  db.close();
});
