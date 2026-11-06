// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, AxisError, openDatabase, runMigrations, schemaVersion, type DatabaseSync } from "@axis/audit";
import { JOURNAL_MIGRATIONS, JOURNAL_SCHEMA_VERSION, Journal } from "../src/index.js";

const SHA = "b".repeat(40);
const V3 = JOURNAL_MIGRATIONS.slice(0, 3);
const V4 = JOURNAL_MIGRATIONS[3]!;
const code = (c: string) => (e: unknown) => e instanceof AxisError && e.code === c;

/** A database exactly as the previous release left it: version 3, with data in every table the rebuild touches. */
function oldDatabase(): { db: DatabaseSync; audit: AuditLog } {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db);
  runMigrations(db, "journal", V3);
  const ws = db.prepare(
    "INSERT INTO agent_workspaces (id, project_id, branch, base_ref, base_sha, created_by, state, reconcile_reported, created_at, updated_at) VALUES (?, 'proj-a', ?, 'main', ?, 'user', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')",
  );
  ws.run("w-creating", "axis/c", SHA, "CREATING", 0);
  ws.run("w-ready", "axis/r", SHA, "READY", 0);
  ws.run("w-removing", "axis/m", SHA, "REMOVING", 1);
  ws.run("w-removed", "axis/d", SHA, "REMOVED", 0);
  ws.run("w-failed", "axis/f", SHA, "FAILED", 0);
  db.prepare("INSERT INTO agent_runs (id, workspace_id, kind, state, reason, exit_code, created_at, updated_at, started_at, ended_at) VALUES ('r1', 'w-ready', 'cli', 'FAILED', 'BOOM', 3, 'a', 'b', 'c', 'd')").run();
  db.prepare("INSERT INTO agent_runs (id, workspace_id, kind, state, created_at, updated_at) VALUES ('r2', 'w-ready', 'composer', 'QUEUED', 'a', 'b')").run();
  db.prepare("INSERT INTO state_transitions (entity, entity_id, from_state, to_state, reason, actor, ts) VALUES ('workspace', 'w-ready', 'CREATING', 'READY', NULL, 'user', 't')").run();
  db.prepare("INSERT INTO idempotency (scope, key, request_hash, result_id, created_at) VALUES ('s', 'k', 'h', 'w-ready', 't')").run();
  db.prepare(
    "INSERT INTO daemon_idempotency (actor_id, workspace_id, contract, version, method, key, request_hash, state, boot_id, created_at, expires_at) VALUES ('user', 'w-ready', 'axis.x', 1, 'm', 'k1', 'h', 'in-progress', 'boot', 1, 2)",
  ).run();
  db.prepare("INSERT INTO daemon_idempotency_clock (id, trusted_ms) VALUES (1, 77)").run();
  audit.append({ actor: "daemon", action: "journal.recovery", target: "workspace:w-removing", outcome: "success", payload: { reason: "NEEDS_RECONCILE" } });
  audit.append({ actor: "user", action: "git.commit", target: "workspace:w-ready", outcome: "success", payload: { fileCount: 2 } });
  return { db, audit };
}

const dump = (db: DatabaseSync, table: string, order: string): unknown[] =>
  (db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as unknown[]).map((r) => ({ ...(r as object) }));
const schemaOf = (db: DatabaseSync): unknown[] => dump(db, "sqlite_master", "type, name");
const columns = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
const AUDIT_TABLES = ["audit_events"];

test("a fresh database reaches the current version with the new tables and columns", () => {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db);
  Journal.open(db, { audit });
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  assert.ok(JOURNAL_SCHEMA_VERSION >= 4);
  assert.deepEqual(columns(db, "projects"), ["id", "path", "display_name", "trusted", "created_at", "updated_at"]);
  for (const c of ["worktree_path", "lock_state", "locked_at", "last_pushed_sha", "reviewed_tree_hash", "reviewed_at", "finalise_outcome"]) {
    assert.ok(columns(db, "agent_workspaces").includes(c), c);
  }
  assert.deepEqual((db.prepare("PRAGMA foreign_key_check").all() as unknown[]), []);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_list(agent_runs)").all().map((r) => (r as { table: string }).table), ["agent_workspaces"]);
});

test("upgrading a populated version 3 database keeps every row, every index and the foreign keys", () => {
  const { db, audit } = oldDatabase();
  const before = {
    ws: dump(db, "agent_workspaces", "id"),
    runs: dump(db, "agent_runs", "id"),
    tr: dump(db, "state_transitions", "id"),
    idem: dump(db, "idempotency", "scope, key"),
    didem: dump(db, "daemon_idempotency", "key"),
    clock: dump(db, "daemon_idempotency_clock", "id"),
  };
  const journal = Journal.open(db, { audit });
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  const pick = (rows: unknown[], keys: string[]) => rows.map((r) => Object.fromEntries(keys.map((k) => [k, (r as Record<string, unknown>)[k]])));
  const oldCols = Object.keys(before.ws[0] as object);
  assert.deepEqual(pick(dump(db, "agent_workspaces", "id"), oldCols), before.ws, "old columns carried over unchanged");
  for (const r of dump(db, "agent_workspaces", "id") as Array<Record<string, unknown>>) {
    assert.equal(r["worktree_path"], null);
    assert.equal(r["lock_state"], "unlocked");
    assert.equal(r["locked_at"], null);
    assert.equal(r["last_pushed_sha"], null);
    assert.equal(r["reviewed_tree_hash"], null);
    assert.equal(r["finalise_outcome"], null);
  }
  assert.deepEqual(dump(db, "agent_runs", "id"), before.runs);
  assert.deepEqual(dump(db, "state_transitions", "id"), before.tr);
  assert.deepEqual(dump(db, "idempotency", "scope, key"), before.idem);
  assert.deepEqual(dump(db, "daemon_idempotency", "key"), before.didem);
  assert.deepEqual(dump(db, "daemon_idempotency_clock", "id"), before.clock);
  const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_runs' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
  assert.ok(idx.includes("agent_runs_by_workspace") && idx.includes("agent_runs_by_state"));
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  // The foreign key still holds, and the rebuilt table accepts the new state and the old behaviour.
  assert.throws(() => db.prepare("INSERT INTO agent_runs (id, workspace_id, kind, state, created_at, updated_at) VALUES ('x', 'nope', 'cli', 'QUEUED', 'a', 'b')").run());
  assert.equal(journal.getWorkspace("w-ready")?.state, "READY");
  assert.equal(journal.listRuns({ workspaceId: "w-ready" }).length, 2);
});

test("the audit chain tables are byte for byte the same after the upgrade and the chain verifies", () => {
  const { db, audit } = oldDatabase();
  const before = AUDIT_TABLES.map((t) => dump(db, t, "1"));
  const head = audit.head();
  assert.ok(head && head.seq === 2);
  const create = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'audit_events'").get() as { sql: string }).sql;
  Journal.open(db, { audit });
  assert.deepEqual(AUDIT_TABLES.map((t) => dump(db, t, "1")), before);
  assert.equal((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'audit_events'").get() as { sql: string }).sql, create);
  assert.deepEqual(audit.head(), head);
  assert.equal(audit.verify().ok, true);
  assert.equal(schemaVersion(db, "audit"), 1);
});

test("running the migration again changes nothing, including after data was written to the new columns", () => {
  const { db, audit } = oldDatabase();
  const journal = Journal.open(db, { audit });
  journal.registerProject({ id: "proj-a", path: "/work/a", displayName: "A", trusted: true, actor: "user" });
  journal.setWorktreePath("w-ready", "/work/a/.axis/w-ready", "daemon");
  const schema = schemaOf(db);
  const ws = dump(db, "agent_workspaces", "id");
  const head = audit.head();
  Journal.open(db, { audit });
  Journal.open(db, { audit });
  assert.deepEqual(schemaOf(db), schema);
  assert.deepEqual(dump(db, "agent_workspaces", "id"), ws);
  assert.deepEqual(audit.head(), head, "re-opening writes no audit event");
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
});

test("a database from a newer build, or any version above the known one, is refused and left untouched", () => {
  for (const future of [JOURNAL_SCHEMA_VERSION + 1, 99, 2 ** 31]) {
    const { db, audit } = oldDatabase();
    Journal.open(db, { audit });
    db.prepare("UPDATE axis_schema SET version = ? WHERE component = 'journal'").run(future);
    const schema = schemaOf(db);
    const ws = dump(db, "agent_workspaces", "id");
    assert.throws(() => Journal.open(db, { audit }), code("E_UNAVAILABLE"), `version ${future}`);
    assert.deepEqual(schemaOf(db), schema);
    assert.deepEqual(dump(db, "agent_workspaces", "id"), ws);
    assert.equal(schemaVersion(db, "journal"), future, "the recorded version is not rewritten");
  }
});

test("a downgrade is not a migration: there is no way back to version 3, and an old build refuses a newer database", () => {
  const { db, audit } = oldDatabase();
  Journal.open(db, { audit });
  // What a version 3 build does with this database: its list has three entries.
  assert.throws(() => runMigrations(db, "journal", V3), code("E_UNAVAILABLE"));
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  assert.deepEqual(columns(db, "projects").length, 6);
});

test("a migration that fails late rolls back everything, schema and data, in one step", () => {
  const { db } = oldDatabase();
  const schema = schemaOf(db);
  const rows = { ws: dump(db, "agent_workspaces", "id"), runs: dump(db, "agent_runs", "id") };
  // The real version 4, then a statement that fails after the table swap has already happened.
  const broken = [...V3, { version: 4, sql: `${V4.sql}; INSERT INTO projects (id, path, display_name, trusted, created_at, updated_at) VALUES ('p', 'relative', 'x', 7, 't', 't');` }];
  assert.throws(() => runMigrations(db, "journal", broken));
  assert.equal(db.isTransaction, false, "no transaction is left open");
  assert.equal(schemaVersion(db, "journal"), 3);
  assert.deepEqual(schemaOf(db), schema, "no new table, no half-renamed table");
  assert.deepEqual(dump(db, "agent_workspaces", "id"), rows.ws);
  assert.deepEqual(dump(db, "agent_runs", "id"), rows.runs);
  // The old database still opens and upgrades cleanly afterwards.
  Journal.open(db, { audit: new AuditLog(db) });
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
});

test("a leftover half-made table from an earlier failed attempt makes the migration fail without changing anything", () => {
  for (const leftover of ["projects", "agent_workspaces_v4"]) {
    const { db } = oldDatabase();
    db.exec(`CREATE TABLE ${leftover} (junk TEXT)`);
    const schema = schemaOf(db);
    const rows = dump(db, "agent_workspaces", "id");
    assert.throws(() => Journal.open(db, { audit: new AuditLog(db) }));
    assert.equal(schemaVersion(db, "journal"), 3, leftover);
    assert.deepEqual(schemaOf(db), schema);
    assert.deepEqual(dump(db, "agent_workspaces", "id"), rows);
    assert.equal(db.isTransaction, false);
  }
});

test("the version 4 constraints refuse malformed values at the database, not only in the API", () => {
  const db = openDatabase(":memory:");
  Journal.open(db, { audit: new AuditLog(db) });
  const ins = (extra: string, ...args: Array<string | null>) =>
    db.prepare(`INSERT INTO agent_workspaces (id, project_id, branch, base_ref, base_sha, created_by, state, created_at, updated_at, ${extra.split("=")[0]}) VALUES ('w', 'p', 'b', 'r', 's', 'user', 'READY', 't', 't', ?)`).run(...args);
  assert.throws(() => ins("last_pushed_sha", "XYZ"));
  assert.throws(() => ins("last_pushed_sha", "G".repeat(40)));
  assert.throws(() => ins("reviewed_tree_hash", "a".repeat(41)));
  assert.throws(() => ins("lock_state", "locked"), "locked needs locked_at");
  assert.throws(() => ins("finalise_outcome", "merged"), "an outcome only after finalising");
  assert.throws(() => db.prepare("INSERT INTO agent_workspaces (id, project_id, branch, base_ref, base_sha, created_by, state, created_at, updated_at) VALUES ('f', 'p', 'b', 'r', 's', 'user', 'FINALISED', 't', 't')").run(), "FINALISED needs an outcome");
  assert.throws(() => db.prepare("INSERT INTO projects (id, path, display_name, trusted, created_at, updated_at) VALUES ('p', '/a', 'A', 2, 't', 't')").run());
});
