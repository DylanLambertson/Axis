// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, AxisError, openDatabase, runMigrations, schemaVersion, type DatabaseSync } from "@axis/audit";
import { JOURNAL_MIGRATIONS, JOURNAL_SCHEMA_VERSION, Journal } from "../src/index.js";

const SHA = "c".repeat(40);
const V4 = JOURNAL_MIGRATIONS.slice(0, 4);
const V5 = JOURNAL_MIGRATIONS[4]!;
const code = (c: string) => (e: unknown) => e instanceof AxisError && e.code === c;

/** A database exactly as the previous release left it: version 4, workspaces in every state, runs, a project, audit rows. */
function oldDatabase(): { db: DatabaseSync; audit: AuditLog } {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db);
  runMigrations(db, "journal", V4);
  db.prepare("INSERT INTO projects (id, path, display_name, trusted, created_at, updated_at) VALUES ('proj-a', '/work/a', 'A', 1, 't', 't')").run();
  const ws = db.prepare(
    "INSERT INTO agent_workspaces (id, project_id, branch, base_ref, base_sha, created_by, state, created_at, updated_at) VALUES (?, 'proj-a', ?, 'HEAD', ?, 'user', ?, 't1', 't2')",
  );
  for (const [id, state] of [["w-creating", "CREATING"], ["w-ready", "READY"], ["w-removed", "REMOVED"], ["w-failed", "FAILED"]] as const) ws.run(id, `axis/${id}`, SHA, state);
  db.prepare("INSERT INTO agent_workspaces (id, project_id, branch, base_ref, base_sha, created_by, state, created_at, updated_at, finalise_outcome) VALUES ('w-fin', 'proj-a', 'axis/f', 'HEAD', ?, 'user', 'FINALISED', 't1', 't2', 'merged')").run(SHA);
  db.prepare("INSERT INTO agent_runs (id, workspace_id, kind, state, created_at, updated_at) VALUES ('r1', 'w-ready', 'cli', 'QUEUED', 'a', 'b')").run();
  db.prepare("INSERT INTO state_transitions (entity, entity_id, from_state, to_state, reason, actor, ts) VALUES ('workspace', 'w-ready', 'CREATING', 'READY', NULL, 'user', 't')").run();
  audit.append({ actor: "user", action: "git.commit", target: "workspace:w-ready", outcome: "success", payload: { fileCount: 2 } });
  return { db, audit };
}

const dump = (db: DatabaseSync, table: string, order: string): Array<Record<string, unknown>> =>
  (db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as unknown[]).map((r) => ({ ...(r as object) }));
const schemaOf = (db: DatabaseSync): unknown[] => dump(db, "sqlite_master", "type, name");
const columns = (db: DatabaseSync): string[] => (db.prepare("PRAGMA table_info(agent_workspaces)").all() as Array<{ name: string }>).map((c) => c.name);
const without = (rows: Array<Record<string, unknown>>, key: string) => rows.map(({ [key]: _drop, ...rest }) => rest);

function creating(journal: Journal, branch = "axis/new"): string {
  return journal.createWorkspace({ projectId: "proj-a", branch, baseRef: "HEAD", baseSha: SHA, createdBy: "daemon" }).value.id;
}

test("a fresh database has the base_branch column, empty for a new workspace", () => {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  assert.ok(JOURNAL_SCHEMA_VERSION >= 5);
  assert.ok(columns(db).includes("base_branch"));
  assert.equal(journal.getWorkspace(creating(journal))?.baseBranch, null);
});

test("upgrading a populated version 4 database loses nothing and leaves every old workspace without a base branch", () => {
  const { db, audit } = oldDatabase();
  const before = {
    ws: dump(db, "agent_workspaces", "id"), runs: dump(db, "agent_runs", "id"), tr: dump(db, "state_transitions", "id"),
    projects: dump(db, "projects", "id"), audit: dump(db, "audit_events", "1"),
  };
  const head = audit.head();
  const journal = Journal.open(db, { audit });
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  const after = dump(db, "agent_workspaces", "id");
  assert.deepEqual(without(after, "base_branch"), before.ws, "every old column of every row is unchanged");
  assert.ok(after.every((r) => r["base_branch"] === null), "old workspaces are not attestable: no base branch is invented");
  assert.equal(journal.getWorkspace("w-fin")?.baseBranch, null);
  assert.deepEqual(dump(db, "agent_runs", "id"), before.runs);
  assert.deepEqual(dump(db, "state_transitions", "id"), before.tr);
  assert.deepEqual(dump(db, "projects", "id"), before.projects);
  assert.deepEqual(dump(db, "audit_events", "1"), before.audit);
  assert.deepEqual(audit.head(), head);
  assert.equal(audit.verify().ok, true);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("re-opening changes nothing; a newer database is refused; there is no way back to version 4", () => {
  const { db, audit } = oldDatabase();
  const journal = Journal.open(db, { audit });
  journal.recordBaseBranch("w-creating", "refs/heads/main", "daemon");
  const schema = schemaOf(db);
  const rows = dump(db, "agent_workspaces", "id");
  Journal.open(db, { audit });
  Journal.open(db, { audit });
  assert.deepEqual(schemaOf(db), schema);
  assert.deepEqual(dump(db, "agent_workspaces", "id"), rows);
  assert.throws(() => runMigrations(db, "journal", V4), code("E_UNAVAILABLE"), "an older build refuses");
  db.prepare("UPDATE axis_schema SET version = ? WHERE component = 'journal'").run(JOURNAL_SCHEMA_VERSION + 1);
  assert.throws(() => Journal.open(db, { audit }), code("E_UNAVAILABLE"));
  assert.deepEqual(schemaOf(db), schema);
});

test("a migration that fails after the column was added rolls back the column and the trigger", () => {
  const { db } = oldDatabase();
  const schema = schemaOf(db);
  const rows = dump(db, "agent_workspaces", "id");
  const broken = [...V4, { version: 5, sql: `${V5.sql}; INSERT INTO projects (id, path, display_name, trusted, created_at, updated_at) VALUES ('p', 'relative', 'x', 7, 't', 't');` }];
  assert.throws(() => runMigrations(db, "journal", broken));
  assert.equal(db.isTransaction, false);
  assert.equal(schemaVersion(db, "journal"), 4);
  assert.deepEqual(schemaOf(db), schema, "no column, no trigger left behind");
  assert.deepEqual(dump(db, "agent_workspaces", "id"), rows);
  Journal.open(db, { audit: new AuditLog(db) });
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
});

test("a leftover trigger from a failed attempt makes the migration fail without changing anything", () => {
  const { db } = oldDatabase();
  db.exec("CREATE TRIGGER agent_workspaces_base_branch_once AFTER INSERT ON projects BEGIN SELECT 1; END");
  const schema = schemaOf(db);
  assert.throws(() => Journal.open(db, { audit: new AuditLog(db) }));
  assert.equal(schemaVersion(db, "journal"), 4);
  assert.deepEqual(schemaOf(db), schema);
  assert.equal(db.isTransaction, false);
});

test("the database refuses a malformed base branch, and refuses to change or clear one once recorded", () => {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  const id = creating(journal);
  const set = (v: string | null) => db.prepare("UPDATE agent_workspaces SET base_branch = ? WHERE id = ?").run(v, id);
  for (const bad of ["main", "HEAD", "refs/tags/v1", "refs/heads/", "refs/heads/a b", "refs/heads/a\nb", "refs/heads/a..b", "refs/heads/é", `refs/heads/${"a".repeat(300)}`, "heads/main", ""]) {
    assert.throws(() => set(bad), JSON.stringify(bad.slice(0, 30)));
  }
  set("refs/heads/main");
  set("refs/heads/main");
  assert.throws(() => set("refs/heads/other"), /recorded once/);
  assert.throws(() => set(null), /recorded once/);
  assert.equal(journal.getWorkspace(id)?.baseBranch, "refs/heads/main");
  db.prepare("UPDATE agent_workspaces SET state = 'READY', updated_at = 'x' WHERE id = ?").run(id); // other updates are unaffected
});

test("recordBaseBranch: only while CREATING, once, a valid branch, audited without the value", () => {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db);
  const journal = Journal.open(db, { audit });
  journal.registerProject({ id: "proj-a", path: "/work/a", displayName: "A", trusted: true, actor: "user" });
  const id = creating(journal);
  const head = audit.head()!.seq;
  assert.equal(journal.recordBaseBranch(id, "refs/heads/main", "daemon").baseBranch, "refs/heads/main");
  assert.equal(audit.head()!.seq, head + 1);
  assert.equal(journal.recordBaseBranch(id, "refs/heads/main", "daemon").baseBranch, "refs/heads/main", "same value is a no-op");
  assert.equal(audit.head()!.seq, head + 1, "and writes no second audit row");
  assert.throws(() => journal.recordBaseBranch(id, "refs/heads/evil", "daemon"), code("E_CONFLICT"));
  for (const bad of ["main", "refs/heads/a b", "refs/heads/a..b", "refs/heads/é", "refs/remotes/o/main"]) {
    assert.throws(() => journal.recordBaseBranch(creating(journal, `axis/${bad.length}${bad.length}x`), bad, "daemon"), code("E_INVALID_ARGUMENT"), bad);
  }
  assert.throws(() => journal.recordBaseBranch("nope", "refs/heads/main", "daemon"), code("E_NOT_FOUND"));
  const ready = creating(journal, "axis/ready");
  journal.transitionWorkspace(ready, "READY", { actor: "daemon" });
  assert.throws(() => journal.recordBaseBranch(ready, "refs/heads/main", "daemon"), code("E_CONFLICT"), "a READY workspace cannot be given a base afterwards");
  assert.equal(journal.getWorkspace(ready)?.baseBranch, null);
  assert.equal(audit.verify().ok, true);
});
