// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { AuditLog, AxisError, openDatabase, runMigrations, schemaVersion, type DatabaseSync } from "@axis/audit";
import { JOURNAL_MIGRATIONS, JOURNAL_SCHEMA_VERSION, Journal } from "../src/index.js";

// Project registration and the run-trust record (docs/design/project-registration-and-trust.md §3): schema version 11.

const V10 = JOURNAL_MIGRATIONS.slice(0, 10);
const abs = (p: string): string => resolve("/axis-test", p);
const code = (c: string) => (e: unknown) => e instanceof AxisError && e.code === c;
const TS = "2026-11-21T00:00:00.000Z";
const BIND = { commonDir: abs("one/.git"), gitDirId: "2049:131074" };

/** A version 10 database with two project rows written as the old code could: one trusted, one not. */
function v10(): DatabaseSync {
  const db = openDatabase(":memory:");
  new AuditLog(db);
  runMigrations(db, "journal", V10);
  const insert = db.prepare("INSERT INTO projects (id, path, display_name, trusted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
  insert.run("p1", abs("one"), "One", 1, TS, TS);
  insert.run("p2", abs("two"), "Two", 0, TS, TS);
  return db;
}

function events(db: DatabaseSync): { actor: string; action: string; target: string }[] {
  return (db.prepare("SELECT actor, action, target FROM audit_events ORDER BY seq").all() as { actor: string; action: string; target: string }[]).map((r) => ({ ...r }));
}

function fresh(): { db: DatabaseSync; journal: Journal } {
  const db = openDatabase(":memory:");
  return { db, journal: Journal.open(db, { audit: new AuditLog(db) }) };
}

test("version 11 resets every trusted row to 0, keeps the rows, and leaves them unbound", () => {
  const db = v10();
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  assert.ok(JOURNAL_SCHEMA_VERSION >= 11);
  for (const id of ["p1", "p2"]) {
    const p = journal.getProject(id);
    assert.equal(p?.trusted, false, `${id}: no row keeps a trust no dialog gave`);
    assert.deepEqual([p?.commonDir, p?.gitDirId, p?.trustChangedAt], [null, null, null]);
  }
  assert.equal(journal.getProject("p1")?.path, abs("one"));
});

test("version 11: a path never changes; the binding is set once from NULL and then fixed; a common dir is unique", () => {
  const db = v10();
  Journal.open(db, { audit: new AuditLog(db) });
  assert.throws(() => db.prepare("UPDATE projects SET path = ? WHERE id = 'p1'").run(abs("moved")), /keeps its path/);
  db.prepare("UPDATE projects SET common_dir = ?, git_dir_id = ? WHERE id = 'p1'").run(BIND.commonDir, BIND.gitDirId);
  assert.throws(() => db.prepare("UPDATE projects SET common_dir = ? WHERE id = 'p1'").run(abs("other/.git")), /keeps its binding/);
  assert.throws(() => db.prepare("UPDATE projects SET git_dir_id = '1:1' WHERE id = 'p1'").run(), /keeps its binding/);
  assert.throws(() => db.prepare("UPDATE projects SET common_dir = NULL WHERE id = 'p1'").run(), /keeps its binding/);
  // An unchanged value is not a change.
  db.prepare("UPDATE projects SET common_dir = ?, display_name = 'One' WHERE id = 'p1'").run(BIND.commonDir);
  assert.throws(() => db.prepare("UPDATE projects SET common_dir = ? WHERE id = 'p2'").run(BIND.commonDir), /UNIQUE/);
  for (const bad of ["", "1", "a:1", "1:2:3", "-1:2"]) {
    assert.throws(() => db.prepare("UPDATE projects SET git_dir_id = ? WHERE id = 'p2'").run(bad), /CHECK/, bad);
  }
});

test("register: the decision is in the audit action name; the binding is stored with both parts or neither", () => {
  const { db, journal } = fresh();
  journal.registerProject({ id: "a", path: abs("one"), displayName: "One", trusted: true, ...BIND, actor: "daemon" });
  journal.registerProject({ id: "b", path: abs("two"), displayName: "Two", trusted: false, actor: "daemon" });
  assert.deepEqual(events(db).map((e) => e.action), ["journal.project.register.trusted", "journal.project.register.read_only"]);
  assert.deepEqual([journal.getProject("a")?.commonDir, journal.getProject("a")?.gitDirId], [BIND.commonDir, BIND.gitDirId]);
  assert.throws(() => journal.registerProject({ id: "c", path: abs("three"), displayName: "x", trusted: false, commonDir: abs("three/.git"), actor: "daemon" }), code("E_INVALID_ARGUMENT"));
  assert.throws(() => journal.registerProject({ id: "c", path: abs("three"), displayName: "x", trusted: false, ...BIND, actor: "daemon" }), code("E_CONFLICT"), "a repository is one project");
  assert.throws(() => journal.registerProject({ id: "d", path: abs("four"), displayName: "x", trusted: true, actor: "daemon" }), code("E_INVALID_ARGUMENT"), "mutant: trusted without a binding");
  // The schema refuses it too, whatever writes the row.
  assert.throws(() => db.prepare("INSERT INTO projects (id, path, display_name, trusted, created_at, updated_at) VALUES ('e', ?, 'x', 1, 't', 't')").run(abs("five")), /needs its binding/);
  assert.throws(() => db.prepare("UPDATE projects SET trusted = 1 WHERE id = 'b'").run(), /needs its binding/, "mutant: update trigger dropped");
  assert.throws(() => journal.setProjectTrust({ id: "a\u0007", trusted: false, via: "gesture" }), code("E_INVALID_ARGUMENT"));
});

test("setProjectTrust: only a dialog grants, with the binding; actor daemon; one audit row per change and none without one", () => {
  const { db, journal } = fresh();
  journal.registerProject({ id: "a", path: abs("one"), displayName: "One", trusted: false, ...BIND, actor: "daemon" });
  const base = events(db).length;
  assert.throws(() => journal.setProjectTrust({ id: "a", trusted: true, via: "gesture", ...BIND }), code("E_INVALID_ARGUMENT"), "a gesture never grants");
  assert.throws(() => journal.setProjectTrust({ id: "a", trusted: true, via: "dialog" }), code("E_INVALID_ARGUMENT"), "a grant needs the binding");
  assert.throws(() => journal.setProjectTrust({ id: "a", trusted: true, via: "dialog", commonDir: BIND.commonDir, gitDirId: "1:1" }), code("E_INVALID_ARGUMENT"), "another binding");
  assert.throws(() => journal.setProjectTrust({ id: "a", trusted: false, via: "dialog" }), code("E_INVALID_ARGUMENT"), "a dialog only grants");
  assert.throws(() => journal.setProjectTrust({ id: "a", trusted: false, via: "gesture", ...BIND }), code("E_INVALID_ARGUMENT"), "a revoke carries no binding");
  assert.throws(() => journal.setProjectTrust({ id: "nope", trusted: false, via: "gesture" }), code("E_NOT_FOUND"));
  assert.equal(events(db).length, base, "a refused call writes nothing");

  const granted = journal.setProjectTrust({ id: "a", trusted: true, via: "dialog", ...BIND });
  assert.equal(granted.trusted, true);
  assert.notEqual(granted.trustChangedAt, null);
  journal.setProjectTrust({ id: "a", trusted: true, via: "dialog", ...BIND });
  journal.setProjectTrust({ id: "a", trusted: false, via: "gesture" });
  journal.setProjectTrust({ id: "a", trusted: false, via: "binding_lost" });
  journal.setProjectTrust({ id: "a", trusted: true, via: "dialog", ...BIND });
  journal.setProjectTrust({ id: "a", trusted: false, via: "binding_lost" });
  assert.deepEqual(events(db).slice(base), [
    { actor: "daemon", action: "journal.project.trust.grant_dialog", target: "project:a" },
    { actor: "daemon", action: "journal.project.trust.revoke_gesture", target: "project:a" },
    { actor: "daemon", action: "journal.project.trust.grant_dialog", target: "project:a" },
    { actor: "daemon", action: "journal.project.trust.binding_lost", target: "project:a" },
  ]);
});

test("a pre-v11 row re-binds through the dialog and keeps its id; a re-bind onto another row's repository is a conflict", () => {
  const db = v10();
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  const bound = journal.setProjectTrust({ id: "p1", trusted: true, via: "dialog", ...BIND });
  assert.deepEqual([bound.id, bound.trusted, bound.commonDir, bound.gitDirId], ["p1", true, BIND.commonDir, BIND.gitDirId]);
  assert.throws(() => journal.setProjectTrust({ id: "p2", trusted: true, via: "dialog", ...BIND }), code("E_CONFLICT"));
  assert.equal(journal.getProject("p2")?.commonDir, null, "the refused re-bind changed nothing");
  assert.equal(journal.getProject("p2")?.trusted, false);
});
