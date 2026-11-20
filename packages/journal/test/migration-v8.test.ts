// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, AxisError, openDatabase, runMigrations, schemaVersion, type DatabaseSync } from "@axis/audit";
import { JOURNAL_MIGRATIONS, JOURNAL_SCHEMA_VERSION, Journal } from "../src/index.js";

// IAC-T (ticket PV-M0): a composer run's taint is recorded in the journal, only ever set, so a run resumed or seen again
// after a restart starts tainted.

const SHA = "c".repeat(40);
const V7 = JOURNAL_MIGRATIONS.slice(0, 7);
const META = { mode: "agent", providerId: "mock", modelId: "mock-model" } as const;
const code = (c: string) => (e: unknown) => e instanceof AxisError && e.code === c;

function open(db: DatabaseSync): { journal: Journal; ws: string } {
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  const ws = journal.createWorkspace({ projectId: "p", branch: `axis/w${Math.random().toString(36).slice(2, 8)}`, baseRef: "HEAD", baseSha: SHA, createdBy: "user" }).value.id;
  journal.transitionWorkspace(ws, "READY");
  return { journal, ws };
}
const start = (j: Journal, ws: string): string => j.composer.createRun({ workspaceId: ws, createdBy: "user" }, META).value.id;

test("version 8: a new composer run is untainted; markTainted sets it, idempotently, and get reports it", () => {
  const db = openDatabase(":memory:");
  const { journal, ws } = open(db);
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  assert.ok(JOURNAL_SCHEMA_VERSION >= 8);
  const a = start(journal, ws);
  assert.deepEqual([journal.composer.tainted(a), journal.composer.get(a)?.tainted], [false, false]);
  journal.composer.markTainted(a);
  journal.composer.markTainted(a);
  assert.deepEqual([journal.composer.tainted(a), journal.composer.get(a)?.tainted], [true, true]);
  assert.equal(journal.composer.tainted("no-such-run"), false);
  assert.throws(() => journal.composer.markTainted("no-such-run"), code("E_NOT_FOUND"), "a taint that cannot be recorded is an error");
  db.close();
});

test("version 8: nothing clears a recorded taint, not even a direct update", () => {
  const db = openDatabase(":memory:");
  const { journal, ws } = open(db);
  const a = start(journal, ws);
  journal.composer.markTainted(a);
  assert.throws(() => db.prepare("UPDATE composer_runs SET tainted = 0 WHERE run_id = ?").run(a), /stays tainted/);
  assert.throws(() => db.prepare("UPDATE composer_runs SET tainted = 2 WHERE run_id = ?").run(a));
  // REPLACE would delete the row (no DELETE trigger fires for it) and insert a fresh, untainted one.
  assert.throws(() => db.prepare("INSERT OR REPLACE INTO composer_runs (run_id, mode, provider_id, model_id, created_at) VALUES (?, 'edit', 'mock', 'mock-model', 't')").run(a), /recorded once/);
  assert.throws(() => db.prepare("REPLACE INTO composer_runs (run_id, mode, provider_id, model_id, created_at) VALUES (?, 'edit', 'mock', 'mock-model', 't')").run(a), /recorded once/);
  assert.equal(journal.composer.tainted(a), true);
  db.close();
});

test("upgrading a version 7 database keeps every composer run and leaves it untainted; a taint survives reopening", () => {
  const db = openDatabase(":memory:");
  runMigrations(db, "journal", V7);
  db.prepare("INSERT INTO agent_workspaces (id, project_id, branch, base_ref, base_sha, created_by, state, created_at, updated_at) VALUES ('w1', 'p', 'axis/old', 'HEAD', ?, 'user', 'READY', 't', 't')").run(SHA);
  db.prepare("INSERT INTO agent_runs (id, workspace_id, kind, state, created_at, updated_at) VALUES ('r-old', 'w1', 'composer', 'BLOCKED', 't', 't')").run();
  db.prepare("INSERT INTO composer_runs (run_id, mode, provider_id, model_id, created_at) VALUES ('r-old', 'edit', 'mock', 'mock-model', 't')").run();
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  assert.equal(journal.composer.tainted("r-old"), false);
  journal.composer.markTainted("r-old");
  const again = Journal.open(db, { audit: new AuditLog(db) });
  assert.equal(again.composer.tainted("r-old"), true);
  db.close();
});

test("a version 8 upgrade that fails after the column was added rolls back the column and both triggers", () => {
  const db = openDatabase(":memory:");
  runMigrations(db, "journal", V7);
  const schemaOf = (): unknown[] => (db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all() as unknown[]).map((r) => ({ ...(r as object) }));
  const before = schemaOf();
  const v8 = JOURNAL_MIGRATIONS[7];
  assert.ok(v8 !== undefined && v8.version === 8);
  const broken = [...V7, { version: 8, sql: `${v8.sql}; INSERT INTO composer_runs (run_id) VALUES (NULL);` }];
  assert.throws(() => runMigrations(db, "journal", broken));
  assert.equal(db.isTransaction, false);
  assert.equal(schemaVersion(db, "journal"), 7);
  assert.deepEqual(schemaOf(), before, "no column, no trigger left behind");
  Journal.open(db, { audit: new AuditLog(db) });
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  db.close();
});
