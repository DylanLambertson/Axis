// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { AuditLog, AxisError, openDatabase, runMigrations, schemaVersion, type DatabaseSync } from "@axis/audit";
import { ComposerRecords, JOURNAL_MIGRATIONS, type ActivityRecord, type ActivityType, JOURNAL_SCHEMA_VERSION, Journal, MAX_ACTIVITY_ROW_BYTES } from "../src/index.js";

const SHA = "c".repeat(40);
const V5 = JOURNAL_MIGRATIONS.slice(0, 5);
const V6 = JOURNAL_MIGRATIONS[5]!;
const META = { mode: "edit", providerId: "mock", modelId: "mock-model" } as const;
const code = (c: string) => (e: unknown) => e instanceof AxisError && e.code === c;
const dump = (db: DatabaseSync, table: string, order: string): Array<Record<string, unknown>> =>
  (db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as unknown[]).map((r) => ({ ...(r as object) }));
const schemaOf = (db: DatabaseSync): unknown[] => dump(db, "sqlite_master", "type, name");

function fresh(): { db: DatabaseSync; journal: Journal; ws: string } {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  const ws = journal.createWorkspace({ projectId: "p", branch: "axis/a", baseRef: "HEAD", baseSha: SHA, createdBy: "user" }).value.id;
  journal.transitionWorkspace(ws, "READY");
  return { db, journal, ws };
}
const start = (j: Journal, ws: string) => j.composer.createRun({ workspaceId: ws, createdBy: "user" }, META).value.id;
const ev = (seq: number, type: ActivityType = "text", pad = 0): ActivityRecord => ({ seq, at: "2026-11-10T00:00:00.000Z", type, body: JSON.stringify({ type, n: seq, pad: "x".repeat(pad) }) });

test("a fresh database is at version 6 with the composer tables", () => {
  const { db } = fresh();
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  assert.ok(JOURNAL_SCHEMA_VERSION >= 6);
  for (const t of ["composer_runs", "composer_activity", "composer_activity_totals", "composer_workspace_budgets"]) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), t);
  }
});

test("an unmigrated (version 5) database has no composer records: the store fails on it, Journal.open upgrades it", () => {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db);
  runMigrations(db, "journal", V5);
  db.prepare("INSERT INTO agent_workspaces (id, project_id, branch, base_ref, base_sha, created_by, state, created_at, updated_at) VALUES ('w', 'p', 'b', 'HEAD', ?, 'user', 'READY', 't', 't')").run(SHA);
  db.prepare("INSERT INTO agent_runs (id, workspace_id, kind, state, created_at, updated_at) VALUES ('r-old', 'w', 'composer', 'REVIEWING', 'a', 'b')").run();
  const before = { ws: dump(db, "agent_workspaces", "id"), runs: dump(db, "agent_runs", "id"), audit: dump(db, "audit_events", "1") };
  const unmigrated = new ComposerRecords(db, () => "t", () => assert.fail("not reached"));
  assert.throws(() => unmigrated.get("r-old"), /no such table/);
  assert.throws(() => unmigrated.workspaceBudget("w"), /no such table/);
  const journal = Journal.open(db, { audit });
  assert.equal(schemaVersion(db, "journal"), 6);
  assert.deepEqual(dump(db, "agent_workspaces", "id"), before.ws);
  assert.deepEqual(dump(db, "agent_runs", "id"), before.runs);
  assert.deepEqual(dump(db, "audit_events", "1"), before.audit);
  assert.equal(journal.composer.get("r-old"), undefined, "an older run has no record: nothing is invented");
  assert.deepEqual(journal.composer.workspaceBudget("w"), { tokens: 0, costMicroUsd: 0, requests: 0, unpricedRequests: 0 });
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("forward only: re-opening changes nothing, an older build refuses version 6, a failed upgrade leaves version 5", () => {
  const { db } = fresh();
  const schema = schemaOf(db);
  Journal.open(db, { audit: new AuditLog(db) });
  assert.deepEqual(schemaOf(db), schema);
  assert.throws(() => runMigrations(db, "journal", V5), code("E_UNAVAILABLE"));
  const old = openDatabase(":memory:");
  runMigrations(old, "journal", V5);
  const oldSchema = schemaOf(old);
  const broken = [...V5, { version: 6, sql: `${V6.sql}; INSERT INTO composer_activity_totals (id, rows, bytes) VALUES (2, 0, 0);` }];
  assert.throws(() => runMigrations(old, "journal", broken));
  assert.equal(schemaVersion(old, "journal"), 5);
  assert.deepEqual(schemaOf(old), oldSchema, "no table or trigger left behind");
});

test("a run is created with its record in one transaction; a bad record creates nothing; a replay keeps the first record", () => {
  const { db, journal, ws } = fresh();
  const runs = () => dump(db, "agent_runs", "id").length;
  assert.throws(() => journal.composer.createRun({ workspaceId: ws, createdBy: "user" }, { ...META, providerId: "Bad Id" }), code("E_INVALID_ARGUMENT"));
  assert.throws(() => journal.composer.createRun({ workspaceId: ws, createdBy: "user" }, { ...META, mode: "root" as never }), code("E_INVALID_ARGUMENT"));
  assert.equal(runs(), 0);
  // The record's insert fails after the run's: the run is rolled back with it.
  db.exec("CREATE TRIGGER fail_record BEFORE INSERT ON composer_runs BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  assert.throws(() => start(journal, ws));
  assert.equal(runs(), 0);
  db.exec("DROP TRIGGER fail_record");
  const key = randomUUID();
  const first = journal.composer.createRun({ workspaceId: ws, createdBy: "user", idempotencyKey: key }, META);
  const again = journal.composer.createRun({ workspaceId: ws, createdBy: "user", idempotencyKey: key }, { ...META, modelId: "other" });
  assert.deepEqual([again.replayed, again.value.id], [true, first.value.id]);
  const rec = journal.composer.get(first.value.id);
  assert.deepEqual([rec?.mode, rec?.providerId, rec?.modelId, rec?.usage, rec?.lastSeq], ["edit", "mock", "mock-model", null, 0]);
  assert.equal(journal.getRun(first.value.id)?.kind, "composer");
});

test("the database keeps a record as started: mode, provider and model never change, records and budgets are never deleted", () => {
  const { db, journal, ws } = fresh();
  const id = start(journal, ws);
  for (const sql of ["UPDATE composer_runs SET mode = 'agent'", "UPDATE composer_runs SET provider_id = 'other'", "UPDATE composer_runs SET model_id = 'm2'", "DELETE FROM composer_runs"]) {
    assert.throws(() => db.exec(sql), /recorded once|never deleted/, sql);
  }
  journal.composer.recordBudget(id, ws, { tokens: 10, costMicroUsd: 0, requests: 2, unpricedRequests: 0 }, { tokens: 50, costMicroUsd: 0, requests: 3, unpricedRequests: 1 });
  for (const sql of ["DELETE FROM composer_workspace_budgets", "UPDATE composer_workspace_budgets SET requests = 0", "UPDATE composer_workspace_budgets SET unpriced = 0", "UPDATE composer_runs SET budget_requests = 0"]) {
    assert.throws(() => db.exec(sql), /never deleted|only moves forward/, sql);
  }
  journal.composer.append(id, ev(1));
  assert.throws(() => db.exec("UPDATE composer_activity SET body = '{\"type\":\"text\"}'"), /never changed/);
  assert.throws(() => journal.composer.append(id, ev(1)), "a sequence number is used once and only grows");
  assert.equal(journal.composer.get(id)?.lastSeq, 1);
  assert.throws(() => db.prepare("INSERT INTO composer_activity (run_id, seq, type, at, body) VALUES (?, 2, 'text', 't', '{\"type\":\"tool\"}')").run(id), "the body's type is the row's");
  assert.throws(() => db.prepare("INSERT INTO composer_activity (run_id, seq, type, at, body) VALUES (?, 2, 'text', 't', 'not json')").run(id));
});

test("usage and budget totals round-trip; a budget is charged only to the run's own workspace", () => {
  const { journal, ws } = fresh();
  const other = journal.createWorkspace({ projectId: "p", branch: "axis/b", baseRef: "HEAD", baseSha: SHA, createdBy: "user" }).value.id;
  journal.transitionWorkspace(other, "READY");
  const id = start(journal, ws);
  journal.composer.recordUsage(id, { inputTokens: 7, outputTokens: 3, requests: 1 });
  const run = { tokens: 10, costMicroUsd: 4, requests: 1, unpricedRequests: 0 };
  journal.composer.recordBudget(id, ws, run, { ...run, tokens: 110 });
  assert.deepEqual(journal.composer.get(id)?.usage, { inputTokens: 7, outputTokens: 3, requests: 1 });
  assert.deepEqual(journal.composer.get(id)?.budget, run);
  assert.deepEqual(journal.composer.workspaceBudget(ws), { ...run, tokens: 110 });
  assert.throws(() => journal.composer.recordBudget(id, other, run, run), code("E_CONFLICT"));
  assert.deepEqual(journal.composer.workspaceBudget(other).tokens, 0, "nothing was charged to the other workspace");
  assert.throws(() => journal.composer.recordBudget(id, ws, { ...run, tokens: -1 }, run), code("E_INVALID_ARGUMENT"));
  assert.throws(() => journal.composer.recordBudget(id, ws, run, { ...run, requests: 1.5 }), code("E_INVALID_ARGUMENT"));
  assert.throws(() => journal.composer.recordUsage("nope", { inputTokens: 0, outputTokens: 0, requests: 0 }), code("E_NOT_FOUND"));
});

test("per run: rows past the cap go oldest first, request rows last, and the newest row is never evicted", () => {
  const { journal, ws } = fresh();
  const id = start(journal, ws);
  const bounds = { maxRunRows: 3, maxRunBytes: 1_000_000, maxRows: 1000, maxBytes: 1_000_000 };
  journal.composer.append(id, ev(1, "request"), bounds);
  for (let s = 2; s <= 6; s++) journal.composer.append(id, ev(s), bounds);
  assert.deepEqual(journal.composer.read(id, 0, 100).map((r) => `${r.seq}:${r.type}`), ["1:request", "5:text", "6:text"]);
  const rec = journal.composer.get(id);
  assert.deepEqual([rec?.activityRows, rec?.lastSeq], [3, 6]);
  // Bytes: one large row pushes out the older ones, never itself.
  const big = { ...bounds, maxRunRows: 100, maxRunBytes: 3000 };
  journal.composer.append(id, ev(7, "text", 2990), big);
  assert.deepEqual(journal.composer.read(id, 0, 100).map((r) => r.seq), [7]);
  journal.composer.append(id, ev(8, "text", 4000), big);
  assert.deepEqual(journal.composer.read(id, 0, 100).map((r) => r.seq), [8], "the newest row stays even over the byte cap");
  assert.equal(journal.composer.append(id, ev(9, "text", MAX_ACTIVITY_ROW_BYTES)), "too_large");
  assert.equal(journal.composer.get(id)?.lastSeq, 8, "a refused row is not recorded");
  assert.deepEqual(journal.composer.read(id, 7, 1).map((r) => r.seq), [8]);
});

test("in total: rows of finished runs go first, even when newer, and a live run's newest row is never evicted", () => {
  const { db, journal, ws } = fresh();
  const bounds = { maxRunRows: 100, maxRunBytes: 1_000_000, maxRows: 4, maxBytes: 1_000_000 };
  const running = () => {
    const id = start(journal, ws);
    journal.transitionRun(id, "RUNNING");
    return id;
  };
  const seqs = (id: string) => journal.composer.read(id, 0, 100).map((r) => r.seq);
  const b = running();
  journal.composer.append(b, ev(1), bounds);
  const a = running();
  journal.composer.append(a, ev(1), bounds);
  journal.composer.append(a, ev(2), bounds);
  const done = running();
  journal.composer.append(done, ev(1), bounds);
  journal.transitionRun(done, "CANCELLED", { reason: "USER_CANCELLED" });
  journal.composer.append(a, ev(3), bounds);
  assert.deepEqual([seqs(done), seqs(a), seqs(b)], [[], [1, 2, 3], [1]], "the finished run's row went first, though it was the newest");
  journal.composer.append(a, ev(4), bounds);
  assert.deepEqual([seqs(a), seqs(b)], [[2, 3, 4], [1]], "then a live run's older row; the other live run's only (newest) row stays");
  const c = running();
  journal.composer.append(c, ev(1), bounds);
  journal.composer.append(c, ev(2), bounds);
  assert.deepEqual([seqs(a), seqs(b), seqs(c)], [[4], [1], [1, 2]], "oldest first among live rows that are not a run's newest");
  const totals = db.prepare("SELECT rows, bytes FROM composer_activity_totals").get() as { rows: number; bytes: number };
  const actual = db.prepare("SELECT count(*) AS rows, coalesce(sum(length(CAST(body AS BLOB))), 0) AS bytes FROM composer_activity").get() as { rows: number; bytes: number };
  assert.deepEqual({ ...totals }, { ...actual }, "the counters match the table");
  assert.ok(totals.rows <= bounds.maxRows);
  assert.throws(() => journal.composer.append(a, ev(5), { ...bounds, maxRows: 0 }), code("E_INVALID_ARGUMENT"));
});
