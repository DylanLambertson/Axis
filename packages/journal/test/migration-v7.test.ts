// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, AxisError, openDatabase, runMigrations, schemaVersion, type DatabaseSync } from "@axis/audit";
import { JOURNAL_MIGRATIONS, JOURNAL_SCHEMA_VERSION, Journal } from "../src/index.js";

const SHA = "c".repeat(40);
const TIP = "d".repeat(40);
const V5 = JOURNAL_MIGRATIONS.slice(0, 5);
const V6 = JOURNAL_MIGRATIONS.slice(0, 6); // the version before this one (J2, composer records)
const code = (c: string) => (e: unknown) => e instanceof AxisError && e.code === c;

/** A database as an older version left it: one workspace with a recorded base branch, others without, in several states. */
function olderDatabase(prior = V6): { db: DatabaseSync; audit: AuditLog } {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db);
  runMigrations(db, "journal", prior);
  db.prepare("INSERT INTO projects (id, path, display_name, trusted, created_at, updated_at) VALUES ('proj-a', '/work/a', 'A', 1, 't', 't')").run();
  const ws = db.prepare(
    "INSERT INTO agent_workspaces (id, project_id, branch, base_ref, base_sha, created_by, state, created_at, updated_at, base_branch) VALUES (?, 'proj-a', ?, 'HEAD', ?, 'user', ?, 't1', 't2', ?)",
  );
  ws.run("w-based", "axis/based", SHA, "READY", "refs/heads/main");
  ws.run("w-creating", "axis/creating", SHA, "CREATING", "refs/heads/main");
  ws.run("w-plain", "axis/plain", SHA, "READY", null);
  return { db, audit };
}

const rows = (db: DatabaseSync): Array<Record<string, unknown>> =>
  (db.prepare("SELECT * FROM agent_workspaces ORDER BY id").all() as unknown[]).map((r) => ({ ...(r as object) }));
const tipOf = (db: DatabaseSync, id: string): unknown => (db.prepare("SELECT base_tip FROM agent_workspaces WHERE id = ?").get(id) as { base_tip: unknown }).base_tip;

function creating(journal: Journal, branch = "axis/new"): string {
  return journal.createWorkspace({ projectId: "proj-a", branch, baseRef: "HEAD", baseSha: SHA, createdBy: "daemon" }).value.id;
}

for (const prior of [V5, V6]) {
  test(`upgrading a version ${prior.length} database adds an empty base_tip and changes nothing else: an old base branch stays unattestable`, () => {
    const { db, audit } = olderDatabase(prior);
    const before = rows(db);
    const journal = Journal.open(db, { audit });
    assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
    assert.ok(JOURNAL_SCHEMA_VERSION >= 7);
    const after = rows(db);
    assert.deepEqual(after.map(({ base_tip: _t, ...rest }) => rest), before);
    assert.ok(after.every((r) => r["base_tip"] === null), "no tip is invented for an old row");
    assert.equal(journal.getWorkspace("w-based")?.baseBranch, "refs/heads/main");
    assert.equal(journal.getWorkspace("w-based")?.baseTip, null);
    assert.throws(() => runMigrations(db, "journal", prior), code("E_UNAVAILABLE"), "no way back");
    assert.throws(() => runMigrations(db, "journal", V6), code("E_UNAVAILABLE"), "an older build refuses");
  });
}

test("a version 7 upgrade that fails part way leaves the version 6 database as it was, and a later open completes it", () => {
  const { db, audit } = olderDatabase();
  const before = rows(db);
  const v7 = JOURNAL_MIGRATIONS[6]!;
  assert.throws(() => runMigrations(db, "journal", [...V6, { version: 7, sql: `${v7.sql}; SELECT RAISE(ABORT, 'boom');` }]));
  assert.equal(schemaVersion(db, "journal"), 6);
  assert.deepEqual(rows(db), before, "no base_tip column, no row changed");
  Journal.open(db, { audit });
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
});

test("the database refuses a tip added later to a row whose base branch is already recorded", () => {
  const { db, audit } = olderDatabase();
  const journal = Journal.open(db, { audit });
  assert.throws(() => db.prepare("UPDATE agent_workspaces SET base_tip = ? WHERE id = 'w-based'").run(TIP), /recorded once, with the base branch/);
  assert.throws(() => journal.recordBaseBranch("w-creating", "refs/heads/main", TIP, "daemon"), code("E_CONFLICT"), "an older base is never given a tip");
  assert.equal(tipOf(db, "w-creating"), null);
});

test("the database records a tip only with its branch, well-formed, once, and never clears it", () => {
  const { db, audit } = olderDatabase();
  Journal.open(db, { audit });
  const both = db.prepare("UPDATE agent_workspaces SET base_branch = ?, base_tip = ? WHERE id = 'w-plain'");
  assert.throws(() => db.prepare("UPDATE agent_workspaces SET base_tip = ? WHERE id = 'w-plain'").run(TIP), /with the base branch/, "a tip needs a branch");
  assert.throws(() => db.prepare("UPDATE agent_workspaces SET base_branch = 'refs/heads/main' WHERE id = 'w-plain'").run(), /recorded with its tip/, "a branch needs a tip");
  for (const bad of ["", "d".repeat(39), "d".repeat(41), "D".repeat(40), `${"d".repeat(39)}g`, "d".repeat(63)]) {
    assert.throws(() => both.run("refs/heads/main", bad), JSON.stringify(bad));
  }
  both.run("refs/heads/main", TIP);
  both.run("refs/heads/main", TIP); // the same pair again changes nothing
  assert.throws(() => db.prepare("UPDATE agent_workspaces SET base_tip = ? WHERE id = 'w-plain'").run("e".repeat(40)), /recorded once/);
  assert.throws(() => db.prepare("UPDATE agent_workspaces SET base_tip = NULL WHERE id = 'w-plain'").run(), /recorded once/);
  assert.equal(tipOf(db, "w-plain"), TIP);
});

test("recordBaseBranch: the branch and its tip together, once, only while CREATING; a malformed tip is refused", () => {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db);
  const journal = Journal.open(db, { audit });
  journal.registerProject({ id: "proj-a", path: "/work/a", displayName: "A", trusted: true, actor: "user" });
  for (const bad of ["", "abc", TIP.toUpperCase(), `${TIP} `, "refs/heads/main"]) {
    assert.throws(() => journal.recordBaseBranch(creating(journal, `axis/t${bad.length}`), "refs/heads/main", bad, "daemon"), code("E_INVALID_ARGUMENT"), bad);
  }
  const id = creating(journal);
  const head = audit.head()!.seq;
  const ws = journal.recordBaseBranch(id, "refs/heads/main", TIP, "daemon");
  assert.deepEqual([ws.baseBranch, ws.baseTip], ["refs/heads/main", TIP]);
  assert.equal(audit.head()!.seq, head + 1);
  assert.equal(journal.recordBaseBranch(id, "refs/heads/main", TIP, "daemon").baseTip, TIP, "the same pair is a no-op");
  assert.equal(audit.head()!.seq, head + 1);
  assert.throws(() => journal.recordBaseBranch(id, "refs/heads/main", "e".repeat(40), "daemon"), code("E_CONFLICT"), "a different tip");
  assert.equal(journal.getWorkspace(id)?.baseTip, TIP);
  const long = creating(journal, "axis/long");
  assert.equal(journal.recordBaseBranch(long, "refs/heads/main", "f".repeat(64), "daemon").baseTip, "f".repeat(64), "a sha-256 tip");
  const ready = creating(journal, "axis/ready");
  journal.transitionWorkspace(ready, "READY", { actor: "daemon" });
  assert.throws(() => journal.recordBaseBranch(ready, "refs/heads/main", TIP, "daemon"), code("E_CONFLICT"));
  assert.equal(journal.getWorkspace(ready)?.baseTip, null);
  assert.equal(audit.verify().ok, true);
});
