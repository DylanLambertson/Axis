// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase, runMigrations, schemaVersion, type DatabaseSync } from "@axis/audit";
import { JOURNAL_MIGRATIONS, JOURNAL_SCHEMA_VERSION, Journal, PLUGIN_LIMITS, PLUGIN_PERMISSIONS } from "../src/index.js";

// Plugin grants (ticket PV-K1b): schema version 16, the table rules. Every rule has a refusing case next to the closest
// accepted value, and every insert verb is tried against every insert-once guard. The store is plugin-grant-store.test.ts.

const T = "2026-11-22T00:00:00.000Z";
type Val = string | number | null;
type Row = Record<string, Val>;

function setup(): { db: DatabaseSync; journal: Journal } {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  journal.registerProject({ id: "p1", path: "/repo/one", displayName: "One", trusted: false, actor: "user" });
  journal.registerProject({ id: "p2", path: "/repo/two", displayName: "Two", trusted: false, actor: "user" });
  return { db, journal };
}
function insert(db: DatabaseSync, table: string, row: Row, verb = "INSERT", tail = ""): void {
  const cols = Object.keys(row);
  db.prepare(`${verb} INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})${tail}`).run(...Object.values(row));
}
const en = (over: Row = {}): Row => ({ plugin_id: "acme.board", project_id: "p1", enabled: 0, generation: 1, revokes: 0, set_by: "user", created_at: T, updated_at: T, ...over });
const gr = (over: Row = {}): Row => ({ plugin_id: "acme.board", project_id: "p1", permission: "pages.read", granted_by: "user", granted_at: T, ...over });
const refused = (f: () => void, what: string): void => assert.throws(f, Error, what);
const one = (db: DatabaseSync, sql: string, ...a: Val[]): Val => Object.values(db.prepare(sql).get(...a) as Row)[0] as Val;
const gen = (db: DatabaseSync): Val => one(db, "SELECT generation FROM plugin_enablement WHERE plugin_id = 'acme.board' AND project_id = 'p1'");

test("version 16: a populated version 15 database gains the two empty tables and keeps its rows", () => {
  const db = openDatabase(":memory:");
  new AuditLog(db);
  runMigrations(db, "journal", JOURNAL_MIGRATIONS.slice(0, 15));
  db.prepare("INSERT INTO projects (id, path, display_name, trusted, created_at, updated_at) VALUES ('p9', '/r9', 'Nine', 0, ?, ?)").run(T, T);
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  assert.ok(JOURNAL_SCHEMA_VERSION >= 16);
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  for (const t of ["plugin_enablement", "plugin_grants"]) assert.equal(one(db, `SELECT count(*) FROM ${t}`), 0, t);
  assert.equal(one(db, "SELECT count(*) FROM projects WHERE id = 'p9'"), 1, "rows survive");
  assert.equal(journal.plugins.state("acme.board", "p9"), undefined);
  Journal.open(db, { audit: new AuditLog(db) });
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION, "opening again changes nothing");
  db.prepare("UPDATE axis_schema SET version = 99 WHERE component = 'journal'").run();
  assert.throws(() => Journal.open(db, { audit: new AuditLog(db) }), Error, "a newer database is refused (no downgrade)");
  db.close();
});

test("every insert verb is refused for an existing key on both tables, before any conflict clause", () => {
  const { db } = setup();
  insert(db, "plugin_enablement", en());
  insert(db, "plugin_grants", gr());
  for (const [verb, tail] of [["INSERT", ""], ["INSERT OR REPLACE", ""], ["REPLACE", ""], ["INSERT OR IGNORE", ""], ["INSERT", " ON CONFLICT DO NOTHING"], ["INSERT", " ON CONFLICT DO UPDATE SET enabled = 1"]] as const) {
    refused(() => insert(db, "plugin_enablement", en(), verb, tail), `enablement ${verb}${tail}`);
  }
  for (const [verb, tail] of [["INSERT", ""], ["INSERT OR REPLACE", ""], ["REPLACE", ""], ["INSERT OR IGNORE", ""], ["INSERT", " ON CONFLICT DO NOTHING"]] as const) {
    refused(() => insert(db, "plugin_grants", gr(), verb, tail), `grant ${verb}${tail}`);
  }
  assert.equal(one(db, "SELECT count(*) FROM plugin_enablement"), 1);
  assert.equal(one(db, "SELECT count(*) FROM plugin_grants"), 1);
  assert.equal(gen(db), 1, "no refused write moved the generation");
});

test("ids, closed sets and the writer: the closest valid value passes, the next one is refused", () => {
  const { db } = setup();
  insert(db, "plugin_enablement", en({ plugin_id: "a".repeat(64) }));
  for (const bad of ["a".repeat(65), "Acme", "1acme", "acme..b", "acme.", "acme.1b", "acme\u0000x", "acmé", ""]) refused(() => insert(db, "plugin_enablement", en({ plugin_id: bad })), JSON.stringify(bad));
  refused(() => insert(db, "plugin_enablement", en({ project_id: "nope" })), "an unknown project");
  refused(() => insert(db, "plugin_enablement", en({ set_by: "plugin:acme" })), "only the user writes");
  for (const over of [{ enabled: 1 }, { generation: 2 }, { revokes: 1 }]) refused(() => insert(db, "plugin_enablement", en(over)), `starts ${JSON.stringify(over)}`);
  insert(db, "plugin_enablement", en());
  for (const p of PLUGIN_PERMISSIONS) insert(db, "plugin_grants", gr({ permission: p }));
  for (const bad of ["net:example.com", "integration:github", "approvals.resolve", "PAGES.READ", "pages.read\u0000", ""]) refused(() => insert(db, "plugin_grants", gr({ permission: bad })), JSON.stringify(bad));
  refused(() => insert(db, "plugin_grants", gr({ permission: "pages.write", plugin_id: "other.one" })), "a grant needs the plugin added");
  refused(() => insert(db, "plugin_grants", gr({ project_id: "p2", permission: "pages.write" })), "added to that project");
  refused(() => insert(db, "plugin_grants", gr({ permission: "pages.read", granted_by: "daemon", plugin_id: "a".repeat(64) })), "only the user grants");
});

test("the generation grows by one on a disable or a revoke and only then; it never goes back", () => {
  const { db } = setup();
  insert(db, "plugin_enablement", en());
  const upd = (set: string) => db.prepare(`UPDATE plugin_enablement SET ${set} WHERE plugin_id = 'acme.board' AND project_id = 'p1'`).run();
  upd("enabled = 1");
  assert.equal(gen(db), 1, "enabling keeps it");
  refused(() => upd("generation = 2"), "set by the writer alone");
  refused(() => upd("enabled = 0"), "a disable must bump it");
  upd("enabled = 0, generation = 2");
  assert.equal(gen(db), 2);
  refused(() => upd("generation = 1"), "never back");
  refused(() => upd("enabled = 1, generation = 3"), "an enable does not bump it");
  refused(() => upd("revokes = 2, generation = 3"), "revokes move by one");
  refused(() => upd("revokes = revokes + 2"), "revokes jump with no bump");
  refused(() => upd("revokes = revokes - 1"), "revokes never go back");
  insert(db, "plugin_grants", gr());
  db.prepare("DELETE FROM plugin_grants WHERE permission = 'pages.read'").run();
  assert.equal(gen(db), 3, "a revoke bumps it in the same statement");
  assert.equal(one(db, "SELECT revokes FROM plugin_enablement"), 1);
  refused(() => upd("project_id = 'p2'"), "keeps its project");
  refused(() => upd("created_at = '2026-11-23T00:00:00.000Z'"), "keeps its creation time");
});

test("a plugin row is never deleted, a grant never changes, and a project holds at most 64 plugins", () => {
  const { db } = setup();
  insert(db, "plugin_enablement", en());
  insert(db, "plugin_grants", gr());
  refused(() => db.prepare("DELETE FROM plugin_enablement").run(), "kept");
  insert(db, "plugin_enablement", en({ plugin_id: "no.grants" }));
  refused(() => db.prepare("DELETE FROM plugin_enablement WHERE plugin_id = 'no.grants'").run(), "kept even with no grant to hold it");
  refused(() => db.prepare("UPDATE plugin_grants SET permission = 'pages.write'").run(), "a grant never changes");
  refused(() => db.prepare("UPDATE plugin_grants SET granted_at = granted_at").run(), "not even in place");
  for (let i = 2; i < PLUGIN_LIMITS.pluginsPerProject; i++) insert(db, "plugin_enablement", en({ plugin_id: `p${String(i).padStart(3, "0").replace(/\d/g, (d) => "abcdefghij"[Number(d)] as string)}` }));
  assert.equal(one(db, "SELECT count(*) FROM plugin_enablement WHERE project_id = 'p1'"), 64);
  refused(() => insert(db, "plugin_enablement", en({ plugin_id: "one.more" })), "the 65th");
  insert(db, "plugin_enablement", en({ plugin_id: "one.more", project_id: "p2" }));
});
