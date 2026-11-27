// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase, runMigrations, schemaVersion, type DatabaseSync } from "@axis/audit";
import { JOURNAL_MIGRATIONS, JOURNAL_SCHEMA_VERSION, Journal } from "../src/index.js";

// The confirmed forge repository per project (ticket PV-D2 slice 2b, docs/design/forge-pr-list.md §9): schema version 13.
// Every constraint has a refusing case next to the closest accepted value, so loosening any check fails a test.

const T = "2026-11-22T00:00:00.000Z";
const V12 = JOURNAL_MIGRATIONS.slice(0, 12);

function setup(now?: () => Date): { db: DatabaseSync; journal: Journal } {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db), ...(now === undefined ? {} : { now }) });
  journal.registerProject({ id: "p1", path: "/repo/one", displayName: "One", trusted: false, actor: "user" });
  journal.registerProject({ id: "p2", path: "/repo/two", displayName: "Two", trusted: false, actor: "user" });
  return { db, journal };
}
type Row = Record<string, string>;
const pin = (over: Row = {}): Row => ({ project_id: "p1", host: "github.com", owner: "acme", repo: "app", confirmed_by: "user", confirmed_at: T, ...over });
function insert(db: DatabaseSync, row: Row, verb = "INSERT"): void {
  const cols = Object.keys(row);
  db.prepare(`${verb} INTO forge_pins (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...Object.values(row));
}
const rows = (db: DatabaseSync): Row[] => (db.prepare("SELECT * FROM forge_pins ORDER BY project_id").all() as Row[]).map((r) => ({ ...r }));

test("version 13: a version 12 database gains an empty forge_pins and keeps its projects", () => {
  const db = openDatabase(":memory:");
  new AuditLog(db);
  runMigrations(db, "journal", V12);
  db.prepare("INSERT INTO projects (id, path, display_name, trusted, created_at, updated_at) VALUES ('old', '/repo/old', 'Old', 0, ?, ?)").run(T, T);
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  assert.ok(JOURNAL_SCHEMA_VERSION >= 13);
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  assert.deepEqual(rows(db), []);
  assert.equal(journal.getProject("old")?.path, "/repo/old");
  assert.equal(journal.forgePins.get("old"), undefined);
  db.close();
});

test("the store: get is undefined until set; the first set inserts, a re-pin updates the one row in place", () => {
  let tick = 0;
  const { db, journal } = setup(() => new Date(Date.parse(T) + 1000 * tick++));
  assert.equal(journal.forgePins.get("p1"), undefined);
  journal.forgePins.set("p1", { host: "github.com", owner: "Acme", repo: "app" });
  assert.deepEqual(journal.forgePins.get("p1"), { host: "github.com", owner: "Acme", repo: "app" });
  const first = rows(db)[0]?.["confirmed_at"];
  journal.forgePins.set("p1", { host: "github.com", owner: "acme", repo: "other" });
  assert.deepEqual(journal.forgePins.get("p1"), { host: "github.com", owner: "acme", repo: "other" });
  assert.equal(rows(db).length, 1);
  assert.notEqual(rows(db)[0]?.["confirmed_at"], first, "a re-pin records when it was confirmed");
  assert.equal(rows(db)[0]?.["confirmed_by"], "user");
  assert.throws(() => journal.forgePins.set("nope", { host: "github.com", owner: "acme", repo: "app" }), "a pin needs a registered project");
  assert.throws(() => journal.forgePins.set("p2", { host: "gitlab.com", owner: "acme", repo: "app" }), "the store writes nothing the table refuses");
  assert.equal(journal.forgePins.get("p2"), undefined);
  db.close();
});

test("owner and repository: the GitHub patterns of vetOwnerRepo, never . or ..; host github.com; confirmed by the user", () => {
  const { db } = setup();
  // vetOwnerRepo accepts a trailing hyphen, consecutive hyphens and a `.git` suffix (review 1 N1), so the table does too.
  const ok: Row[] = [
    { owner: "A-1", repo: ".github" }, { owner: "x".repeat(39), repo: "r".repeat(100) }, { owner: "a", repo: "a.b_c-d" },
    { owner: "acme-", repo: "app.git" }, { owner: "a--b", repo: "a..b" },
  ];
  for (const [i, over] of ok.entries()) {
    db.prepare("DELETE FROM forge_pins").run();
    insert(db, pin({ ...over, project_id: i % 2 === 0 ? "p1" : "p2" }));
  }
  db.prepare("DELETE FROM forge_pins").run();
  const refused: Row[] = [
    { host: "gitlab.com" }, { host: "GitHub.com" }, { host: "github.com." },
    { owner: "-acme" }, { owner: "x".repeat(40) }, { owner: "" }, { owner: "a_b" }, { owner: "a.b" }, { owner: "é" }, { owner: "a b" },
    { repo: "." }, { repo: ".." }, { repo: "" }, { repo: "r".repeat(101) }, { repo: "a/b" }, { repo: "a b" }, { repo: "a‮" },
    { confirmed_by: "agent:a1" }, { confirmed_by: "User" }, { confirmed_at: "2026" },
    // Review 1 SF-1: SQLite's text checks stop at a NUL; the byte length check refuses one in each column.
    { host: "github.com\0.evil" }, { owner: "a\0/../evil" }, { repo: "app\0/../../evil" },
  ];
  for (const over of refused) assert.throws(() => insert(db, pin(over)), /CHECK constraint failed/, JSON.stringify(over));
  assert.throws(() => insert(db, pin({ project_id: "nope" })), /FOREIGN KEY/);
  assert.deepEqual(rows(db), []);
  db.close();
});

test("a pin is inserted once: INSERT, INSERT OR REPLACE, INSERT OR IGNORE and an upsert on a pinned project all abort", () => {
  const { db } = setup();
  insert(db, pin());
  const before = rows(db);
  for (const verb of ["INSERT", "INSERT OR REPLACE", "REPLACE", "INSERT OR IGNORE"]) {
    assert.throws(() => insert(db, pin({ repo: "evil" }), verb), /a pin is inserted once/, verb);
  }
  assert.throws(() => db.prepare("INSERT INTO forge_pins (project_id, host, owner, repo, confirmed_by, confirmed_at) VALUES ('p1', 'github.com', 'acme', 'evil', 'user', ?) ON CONFLICT (project_id) DO UPDATE SET repo = excluded.repo").run(T), /a pin is inserted once/);
  assert.throws(() => db.prepare("INSERT INTO forge_pins (project_id, host, owner, repo, confirmed_by, confirmed_at) VALUES ('p1', 'github.com', 'acme', 'evil', 'user', ?) ON CONFLICT DO NOTHING").run(T), /a pin is inserted once/);
  assert.deepEqual(rows(db), before);
  insert(db, pin({ project_id: "p2" }));
  assert.equal(rows(db).length, 2, "another project's first pin is accepted");
  db.close();
});

test("a pin keeps its project: an UPDATE, or UPDATE OR REPLACE onto another pinned project, aborts", () => {
  const { db } = setup();
  insert(db, pin());
  insert(db, pin({ project_id: "p2", repo: "two" }));
  const before = rows(db);
  assert.throws(() => db.prepare("UPDATE forge_pins SET project_id = 'p2' WHERE project_id = 'p1'").run(), /a pin keeps its project/);
  assert.throws(() => db.prepare("UPDATE OR REPLACE forge_pins SET project_id = 'p2' WHERE project_id = 'p1'").run(), /a pin keeps its project/);
  assert.deepEqual(rows(db), before);
  db.prepare("UPDATE forge_pins SET repo = 'renamed', confirmed_at = ? WHERE project_id = 'p1'").run(T);
  assert.equal(rows(db)[0]?.["repo"], "renamed", "a re-pin in place is accepted");
  assert.throws(() => db.prepare("UPDATE forge_pins SET repo = '..' WHERE project_id = 'p1'").run(), /CHECK constraint failed/, "the checks hold on update too");
  // Review 1 N2: a re-pin cannot record another confirmer, nor smuggle a NUL in place.
  for (const v of ["agent:a1", "daemon", "User", ""]) {
    assert.throws(() => db.prepare("UPDATE forge_pins SET confirmed_by = ? WHERE project_id = 'p1'").run(v), /CHECK constraint failed/, v);
  }
  assert.throws(() => db.prepare("UPDATE forge_pins SET owner = ? WHERE project_id = 'p1'").run("acme\0x"), /CHECK constraint failed/);
  assert.equal(rows(db)[0]?.["confirmed_by"], "user");
  db.close();
});
