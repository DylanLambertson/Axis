// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase, runMigrations, schemaVersion, type DatabaseSync } from "@axis/audit";
import { JOURNAL_MIGRATIONS, JOURNAL_SCHEMA_VERSION, Journal, TASK_LIMITS, projectTaskBytesSql } from "../src/index.js";

// Tasks (ticket PV-T1 slice 1): schema version 15, the table rules. Every rule has a refusing case next to the closest
// accepted value, and every insert verb is tried against every insert-once guard. The store is task-store.test.ts.

const T = "2026-11-22T00:00:00.000Z";
const SHA = "b".repeat(40);

function setup(): { db: DatabaseSync; journal: Journal; ws: string; ws2: string; run: string } {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  journal.registerProject({ id: "p1", path: "/repo/one", displayName: "One", trusted: false, actor: "user" });
  journal.registerProject({ id: "p2", path: "/repo/two", displayName: "Two", trusted: false, actor: "user" });
  const ready = (projectId: string, branch: string): string => {
    const w = journal.createWorkspace({ projectId, branch, baseRef: "main", baseSha: SHA, createdBy: "user" }).value;
    return journal.transitionWorkspace(w.id, "READY").id;
  };
  const ws = ready("p1", "axis/a");
  const ws2 = ready("p2", "axis/b");
  const run = journal.createRun({ workspaceId: ws, kind: "cli", createdBy: "user" }).value.id as string;
  journal.agents.createGroup({ id: "g1", projectId: "p1", name: "Backend" });
  journal.agents.createGroup({ id: "g2", projectId: "p2", name: "Other" });
  journal.agents.create({ id: "w1", projectId: "p1", name: "Planner", launch: { kind: "cli", entryId: "my-cli" }, homeWorkspaceId: ws, groupId: "g1" });
  journal.agents.create({ id: "w2", projectId: "p2", name: "Far", launch: { kind: "cli", entryId: "my-cli" }, homeWorkspaceId: ws2, groupId: null });
  journal.agents.create({ id: "w3", projectId: "p1", name: "Gone", launch: { kind: "cli", entryId: "my-cli" }, homeWorkspaceId: ws, groupId: null });
  journal.agents.archive("w3");
  return { db, journal, ws, ws2, run };
}
type Val = string | number | null;
type Row = Record<string, Val>;
function insert(db: DatabaseSync, table: string, row: Row, verb = "INSERT", tail = ""): void {
  const cols = Object.keys(row);
  db.prepare(`${verb} INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})${tail}`).run(...Object.values(row));
}
const task = (over: Row = {}): Row => ({ id: "t1", project_id: "p1", source: "user", status: "open", untrusted: 0, hop: 0, last_seq: 0, created_at: T, updated_at: T, ...over });
const rev = (over: Row = {}): Row => {
  const r: Row = { task_id: "t1", seq: 1, title: "Fix it", body: "steps", author_kind: "user", author_id: null, hop: 0, created_at: T, ...over };
  return "bytes" in over ? r : { ...r, bytes: Buffer.byteLength(String(r["title"])) + Buffer.byteLength(String(r["body"])) };
};
const link = (over: Row = {}): Row => ({ task_id: "t1", kind: "pr", target: "42", created_at: T, ...over });
const refused = (f: () => void, what: string): void => assert.throws(f, Error, what);
const one = (db: DatabaseSync, sql: string, ...a: Val[]): Val => Object.values(db.prepare(sql).get(...a) as Row)[0] as Val;

test("version 15 is the latest; a version 14 database gains the three empty tables", () => {
  const db = openDatabase(":memory:");
  new AuditLog(db);
  runMigrations(db, "journal", JOURNAL_MIGRATIONS.slice(0, 14));
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  assert.ok(JOURNAL_SCHEMA_VERSION >= 15);
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  for (const t of ["tasks", "task_revisions", "task_links"]) assert.equal(one(db, `SELECT count(*) FROM ${t}`), 0, t);
  assert.deepEqual(journal.tasks.list("nope"), []);
  db.close();
});

test("every insert verb is refused for an existing key on every table, before any conflict clause", () => {
  const { db } = setup();
  insert(db, "tasks", task());
  insert(db, "task_revisions", rev());
  insert(db, "task_links", link());
  const verbs: [string, string][] = [["INSERT", ""], ["INSERT OR REPLACE", ""], ["REPLACE", ""], ["INSERT OR IGNORE", ""], ["INSERT", " ON CONFLICT DO NOTHING"]];
  for (const [verb, tail] of verbs) {
    refused(() => insert(db, "tasks", task({ project_id: "p2" }), verb, tail), `tasks ${verb}${tail}`);
    refused(() => insert(db, "task_revisions", rev({ title: "Other" }), verb, tail), `task_revisions ${verb}${tail}`);
    refused(() => insert(db, "task_links", link({ created_at: "2026-11-23T00:00:00.000Z" }), verb, tail), `task_links ${verb}${tail}`);
  }
  refused(() => insert(db, "tasks", task(), "INSERT", " ON CONFLICT (id) DO UPDATE SET status = 'done'"), "tasks upsert");
  refused(() => insert(db, "task_revisions", rev(), "INSERT", " ON CONFLICT (task_id, seq) DO UPDATE SET body = 'x'"), "revisions upsert");
  refused(() => insert(db, "task_links", link(), "INSERT", " ON CONFLICT (task_id, kind, target) DO UPDATE SET created_at = 'x'"), "links upsert");
  assert.equal(one(db, "SELECT project_id FROM tasks"), "p1");
  assert.equal(one(db, "SELECT title FROM task_revisions"), "Fix it");
  db.close();
});

test("a task: id, project, closed source and status; it starts empty and untrusted unless the user is its source", () => {
  const { db } = setup();
  for (const id of ["", "-a", "a b", "a".repeat(65), "a\u0000b"]) refused(() => insert(db, "tasks", task({ id })), JSON.stringify(id));
  refused(() => insert(db, "tasks", task({ project_id: "nope" })), "unregistered project");
  for (const source of ["system", "admin", "User"]) refused(() => insert(db, "tasks", task({ source, untrusted: 1 })), `source ${source}`);
  for (const status of ["new", "OPEN", ""]) refused(() => insert(db, "tasks", task({ status })), `status ${status}`);
  refused(() => insert(db, "tasks", task({ untrusted: 1 })), "a user task starts trusted");
  refused(() => insert(db, "tasks", task({ source: "agent" })), "an agent task starts untrusted");
  refused(() => insert(db, "tasks", task({ last_seq: 1 })), "starts with no revision");
  refused(() => insert(db, "tasks", task({ hop: 1 })), "starts at hop 0");
  refused(() => insert(db, "tasks", task({ assignee_kind: "agent", assignee_id: "w1" })), "assigning is its own step");
  for (const s of ["agent", "plugin", "integration"]) insert(db, "tasks", task({ id: `t-${s}`, source: s, untrusted: 1 }));
  insert(db, "tasks", task());
  for (const [col, v] of [["id", "t2"], ["project_id", "p2"], ["source", "agent"], ["created_at", "2026-11-23T00:00:00.000Z"]] as const) {
    refused(() => db.prepare(`UPDATE tasks SET ${col} = ? WHERE id = 't1'`).run(v), col);
    refused(() => db.prepare(`UPDATE OR REPLACE tasks SET ${col} = ? WHERE id = 't1'`).run(v), `${col} or replace`);
  }
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = 't1'").run();
  db.close();
});

test("untrusted and hop are sticky; last_seq is the newest revision; a project holds at most 1,000 tasks", () => {
  const { db } = setup();
  insert(db, "tasks", task({ id: "ta", source: "agent", untrusted: 1 }));
  refused(() => db.prepare("UPDATE tasks SET untrusted = 0 WHERE id = 'ta'").run(), "never trusted again");
  insert(db, "task_revisions", rev({ task_id: "ta", author_kind: "agent", author_id: "w1", hop: 4 }));
  assert.equal(one(db, "SELECT hop FROM tasks WHERE id = 'ta'"), 4);
  refused(() => db.prepare("UPDATE tasks SET hop = 3 WHERE id = 'ta'").run(), "hop never goes down");
  refused(() => db.prepare("UPDATE tasks SET last_seq = 5 WHERE id = 'ta'").run(), "last_seq is the newest revision");
  const stmt = db.prepare("INSERT INTO tasks (id, project_id, source, status, untrusted, hop, last_seq, created_at, updated_at) VALUES (?, 'p2', 'user', 'open', 0, 0, 0, ?, ?)");
  for (let i = 0; i < TASK_LIMITS.tasksPerProject; i++) stmt.run(`x${i}`, T, T);
  refused(() => stmt.run("one-more", T, T), "the 1,001st task");
  db.close();
});

test("a revision: the next number, written first by the source, title and body rules, a closed author set, never changed", () => {
  const { db } = setup();
  insert(db, "tasks", task());
  insert(db, "tasks", task({ id: "tp", source: "plugin", untrusted: 1 }));
  refused(() => insert(db, "task_revisions", rev({ seq: 2 })), "skips a number");
  refused(() => insert(db, "task_revisions", rev({ task_id: "tp" })), "a plugin task's first revision is the plugin's");
  for (const title of ["", " a", "t".repeat(201), "a\u0000b", "a‮b", "a b"]) refused(() => insert(db, "task_revisions", rev({ title })), `title ${JSON.stringify(title)}`);
  refused(() => insert(db, "task_revisions", rev({ body: "x".repeat(TASK_LIMITS.bodyChars + 1) })), "a body over 16,384 characters");
  refused(() => insert(db, "task_revisions", rev({ body: "a\u0000b" })), "a NUL in the body");
  for (const bytes of [0, 10, 12]) refused(() => insert(db, "task_revisions", rev({ bytes })), `bytes ${bytes}`);
  for (const bad of [
    { author_kind: "admin" }, { author_kind: "user", author_id: "x" }, { author_kind: "user", hop: 1 }, { author_kind: "system", author_id: "x" },
    { author_kind: "agent", author_id: null }, { author_kind: "agent", author_id: "a/b" }, { author_kind: "integration", author_id: null },
    { author_kind: "plugin", author_id: "Acme" }, { author_kind: "agent", author_id: "w1", hop: 9 },
  ] as Row[]) refused(() => insert(db, "task_revisions", rev(bad)), JSON.stringify(bad));
  insert(db, "task_revisions", rev({ title: "t".repeat(200), body: "x".repeat(TASK_LIMITS.bodyChars) }));
  insert(db, "task_revisions", rev({ task_id: "tp", author_kind: "plugin", author_id: "acme.tasks", hop: 2 }));
  insert(db, "task_revisions", rev({ seq: 2, author_kind: "system", hop: 0 }));
  assert.equal(one(db, "SELECT untrusted FROM tasks WHERE id = 't1'"), 1, "a system revision makes a user task untrusted");
  for (const [col, v] of [["title", "X"], ["body", "x"], ["author_kind", "user"], ["hop", 1], ["bytes", 3], ["seq", 9], ["created_at", "x"]] as const) {
    refused(() => db.prepare(`UPDATE task_revisions SET ${col} = ? WHERE task_id = 't1' AND seq = 2`).run(v), col);
  }
  refused(() => db.prepare("DELETE FROM task_revisions WHERE task_id = 't1' AND seq = 1").run(), "a revision is not deleted while its task exists");
  db.close();
});

test("an agent's revision makes a user task untrusted for good, with its hop; a later user edit changes neither", () => {
  const { db } = setup();
  insert(db, "tasks", task());
  insert(db, "task_revisions", rev());
  assert.deepEqual([one(db, "SELECT untrusted FROM tasks"), one(db, "SELECT hop FROM tasks")], [0, 0]);
  insert(db, "task_revisions", rev({ seq: 2, author_kind: "agent", author_id: "w1", hop: 5 }));
  insert(db, "task_revisions", rev({ seq: 3 }));
  insert(db, "task_revisions", rev({ seq: 4, author_kind: "integration", author_id: "github", hop: 1 }));
  assert.deepEqual([one(db, "SELECT untrusted FROM tasks"), one(db, "SELECT hop FROM tasks"), one(db, "SELECT last_seq FROM tasks")], [1, 5, 4]);
  db.close();
});

test("the 51st revision deletes the oldest; the sticky flags outlive the revision that set them", () => {
  const { db } = setup();
  insert(db, "tasks", task());
  insert(db, "task_revisions", rev());
  insert(db, "task_revisions", rev({ seq: 2, author_kind: "agent", author_id: "w1", hop: 3 }));
  for (let s = 3; s <= TASK_LIMITS.revisionsPerTask + 2; s++) insert(db, "task_revisions", rev({ seq: s }));
  assert.equal(one(db, "SELECT count(*) FROM task_revisions"), TASK_LIMITS.revisionsPerTask);
  assert.equal(one(db, "SELECT min(seq) FROM task_revisions"), 3, "the agent's revision is gone");
  assert.deepEqual([one(db, "SELECT untrusted FROM tasks"), one(db, "SELECT hop FROM tasks")], [1, 3]);
  db.close();
});

test("assignees: a live agent or a group of the task's project, set after insert", () => {
  const { db } = setup();
  insert(db, "tasks", task());
  for (const [kind, id] of [["agent", "w2"], ["agent", "w3"], ["agent", "nope"], ["group", "g2"], ["group", "nope"], ["worker", "w1"]] as const) {
    refused(() => db.prepare("UPDATE tasks SET assignee_kind = ?, assignee_id = ? WHERE id = 't1'").run(kind, id), `${kind} ${id}`);
  }
  refused(() => db.prepare("UPDATE tasks SET assignee_kind = 'agent' WHERE id = 't1'").run(), "a kind without an id");
  db.prepare("UPDATE tasks SET assignee_kind = 'agent', assignee_id = 'w1' WHERE id = 't1'").run();
  db.prepare("UPDATE tasks SET assignee_kind = 'group', assignee_id = 'g1' WHERE id = 't1'").run();
  db.prepare("UPDATE tasks SET assignee_kind = NULL, assignee_id = NULL WHERE id = 't1'").run();
  db.close();
});

test("links: a run, workspace or page of the task's project, or a pull request number; 32 per task; never changed", () => {
  const { db, ws, ws2, run } = setup();
  insert(db, "tasks", task());
  insert(db, "task_links", link({ kind: "workspace", target: ws }));
  insert(db, "task_links", link({ kind: "run", target: run }));
  insert(db, "task_links", link({ kind: "pr", target: "1" }));
  for (const bad of [
    { kind: "workspace", target: ws2 }, { kind: "workspace", target: "nope" }, { kind: "run", target: "nope" }, { kind: "page", target: "nope" },
    { kind: "pr", target: "0" }, { kind: "pr", target: "01" }, { kind: "pr", target: "1a" }, { kind: "pr", target: "12345678901" },
    { kind: "pr", target: "1\u00002" }, { kind: "url", target: "x" }, { kind: "file", target: "a" },
  ] as Row[]) refused(() => insert(db, "task_links", link(bad)), JSON.stringify(bad));
  refused(() => db.prepare("UPDATE task_links SET target = '2' WHERE kind = 'pr'").run(), "never changed");
  for (let i = 3; i < TASK_LIMITS.linksPerTask; i++) insert(db, "task_links", link({ target: String(100 + i) }));
  refused(() => insert(db, "task_links", link({ target: "999" })), "the 33rd link");
  db.prepare("DELETE FROM task_links WHERE kind = 'pr' AND target = '1'").run();
  db.close();
});

test("a project holds at most 64 MiB of task text, summed from stored counts through a covering index", () => {
  const { db } = setup();
  const plan = (db.prepare(`EXPLAIN QUERY PLAN SELECT ${projectTaskBytesSql("?1")} AS n`).all("p1") as { detail: string }[]).map((r) => r.detail);
  assert.ok(plan.some((d) => d.includes("COVERING INDEX task_revisions_bytes")), plan.join(" | "));
  assert.ok(!plan.some((d) => /\bSCAN\b/.test(d) && /\b(r|task_revisions)\b/.test(d)), plan.join(" | "));
  // 1,000 tasks of 50 revisions cannot fill 64 MiB with 16,384-character bodies alone in a test: fill with a few raw rows.
  db.prepare("INSERT INTO tasks (id, project_id, source, status, untrusted, hop, last_seq, created_at, updated_at) VALUES ('t1', 'p1', 'user', 'open', 0, 0, 0, ?, ?)").run(T, T);
  const body = "é".repeat(TASK_LIMITS.bodyChars); // 32,768 bytes
  const per = Buffer.byteLength("Fix it") + Buffer.byteLength(body);
  let seq = 0;
  // Fill across tasks so no task passes its revision cap.
  for (let t = 0; (seq + 1) * per <= TASK_LIMITS.projectBytes; t++) {
    const id = `f${t}`;
    db.prepare("INSERT INTO tasks (id, project_id, source, status, untrusted, hop, last_seq, created_at, updated_at) VALUES (?, 'p1', 'user', 'open', 0, 0, 0, ?, ?)").run(id, T, T);
    for (let s = 1; s <= TASK_LIMITS.revisionsPerTask && (seq + 1) * per <= TASK_LIMITS.projectBytes; s++, seq++) insert(db, "task_revisions", rev({ task_id: id, seq: s, body }));
  }
  const left = TASK_LIMITS.projectBytes - seq * per;
  assert.ok(left >= 6 && left < per);
  const text = (bytes: number): string => "é".repeat(Math.floor(bytes / 2)) + "x".repeat(bytes % 2);
  refused(() => insert(db, "task_revisions", rev({ body: text(left - 5) })), "one byte past the cap");
  insert(db, "task_revisions", rev({ body: text(left - 6) }));
  assert.equal(one(db, `SELECT ${projectTaskBytesSql("?1")} AS n`, "p1"), TASK_LIMITS.projectBytes);
  insert(db, "tasks", task({ id: "elsewhere", project_id: "p2" }));
  insert(db, "task_revisions", rev({ task_id: "elsewhere", body }));
  db.close();
});

test("deleting a task deletes its revisions and links in the same statement, and nothing else", () => {
  const { db } = setup();
  insert(db, "tasks", task());
  insert(db, "tasks", task({ id: "keep" }));
  insert(db, "task_revisions", rev());
  insert(db, "task_revisions", rev({ task_id: "keep" }));
  insert(db, "task_links", link());
  db.prepare("DELETE FROM tasks WHERE id = 't1'").run();
  assert.equal(one(db, "SELECT count(*) FROM task_revisions WHERE task_id = 't1'"), 0);
  assert.equal(one(db, "SELECT count(*) FROM task_links"), 0);
  assert.equal(one(db, "SELECT count(*) FROM task_revisions WHERE task_id = 'keep'"), 1);
  db.close();
});

test("a trusted task has hop 0, and no task's hop rises above the highest hop of its revisions", () => {
  const { db } = setup();
  insert(db, "tasks", task());
  insert(db, "task_revisions", rev());
  refused(() => db.prepare("UPDATE tasks SET hop = 3 WHERE id = 't1'").run(), "a trusted task with a hop");
  insert(db, "tasks", task({ id: "ta", source: "agent", untrusted: 1 }));
  insert(db, "task_revisions", rev({ task_id: "ta", author_kind: "agent", author_id: "w1", hop: 4 }));
  refused(() => db.prepare("UPDATE tasks SET hop = 5 WHERE id = 'ta'").run(), "a hop above every revision");
  db.prepare("UPDATE tasks SET untrusted = 1 WHERE id = 't1'").run(); // more conservative is allowed
  refused(() => db.prepare("UPDATE tasks SET hop = 1 WHERE id = 't1'").run(), "still no revision at that hop");
  assert.equal(one(db, "SELECT hop FROM tasks WHERE id = 't1'"), 0);
  db.close();
});

test("archiving the assigned agent or deleting the assigned group clears the assignment in the same statement", () => {
  const { db, journal } = setup();
  insert(db, "tasks", task());
  insert(db, "tasks", task({ id: "t2" }));
  db.prepare("UPDATE tasks SET assignee_kind = 'agent', assignee_id = 'w1' WHERE id = 't1'").run();
  db.prepare("UPDATE tasks SET assignee_kind = 'group', assignee_id = 'g1' WHERE id = 't2'").run();
  journal.agents.archive("w1");
  assert.equal(one(db, "SELECT assignee_kind FROM tasks WHERE id = 't1'"), null);
  journal.agents.deleteGroup("g1");
  assert.equal(one(db, "SELECT assignee_kind FROM tasks WHERE id = 't2'"), null);
  db.close();
});

test("a populated version 14 database upgrades with its rows kept; a rerun is idempotent and an older schema list is refused", () => {
  const db = openDatabase(":memory:");
  new AuditLog(db);
  runMigrations(db, "journal", JOURNAL_MIGRATIONS.slice(0, 14));
  db.prepare("INSERT INTO projects (id, path, display_name, trusted, created_at, updated_at) VALUES ('old', '/repo/old', 'Old', 0, ?, ?)").run(T, T);
  db.prepare("INSERT INTO pages (id, project_id, last_seq, created_at, updated_at) VALUES ('pg', 'old', 0, ?, ?)").run(T, T);
  db.prepare("INSERT INTO page_versions (page_id, seq, title, body, bytes, author_kind, author_id, hop, untrusted, created_at) VALUES ('pg', 1, 'P', 'x', 2, 'user', NULL, 0, 0, ?)").run(T);
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  assert.equal(journal.pages.get("pg")?.body, "x", "the page survives");
  journal.tasks.create({ taskId: "t1", projectId: "old", title: "T", body: "b", author: { kind: "user" } });
  assert.equal(journal.tasks.link("t1", { kind: "page", target: "pg" }), true, "a task links to a page from before the upgrade");
  runMigrations(db, "journal", JOURNAL_MIGRATIONS);
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  assert.equal(journal.tasks.get("t1")?.links.length, 1, "a rerun changes nothing");
  assert.throws(() => runMigrations(db, "journal", JOURNAL_MIGRATIONS.slice(0, 14)), Error, "an older build refuses a newer schema");
  db.close();
});
