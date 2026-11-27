// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase, runMigrations, schemaVersion, type DatabaseSync } from "@axis/audit";
import { CLI_ENDPOINT_RECORD_ACTION, CLI_ENDPOINT_SWITCH_MIGRATION, CliEndpointSwitchRecords, JOURNAL_MIGRATIONS, JOURNAL_SCHEMA_VERSION, Journal } from "../src/index.js";

// The CLI messaging endpoint switch (PV-M7 slice 2; `docs/design/axis-messages-shim.md` section 7): schema version 20. One
// row at most, written only by the user, every change audited in the same transaction, and no row meaning off. Each case
// names the rule it pins next to the closest accepted value.

const T = "2026-11-27T00:00:00.000Z";
type Val = string | number | null;
const one = (db: DatabaseSync, sql: string, ...a: Val[]): Val => Object.values(db.prepare(sql).get(...a) as Record<string, Val>)[0] as Val;
const put = (db: DatabaseSync, id: Val = 1, enabled: Val = 1, by: Val = "user", at: Val = T, verb = "INSERT"): void =>
  void db.prepare(`${verb} INTO messaging_cli_endpoint (id, enabled, changed_by, changed_at) VALUES (?, ?, ?, ?)`).run(id, enabled, by, at);
function setup(): { db: DatabaseSync; audit: AuditLog; journal: Journal } {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db);
  return { db, audit, journal: Journal.open(db, { audit }) };
}
const records = (audit: AuditLog) => audit.list().filter((e) => e.action === CLI_ENDPOINT_RECORD_ACTION);

test("a populated database of the previous version gains the empty table, keeps its rows, and reads as off", () => {
  const version = CLI_ENDPOINT_SWITCH_MIGRATION.version;
  assert.equal(version, 20);
  const db = openDatabase(":memory:");
  new AuditLog(db);
  runMigrations(db, "journal", JOURNAL_MIGRATIONS.slice(0, version - 1));
  db.prepare("INSERT INTO projects (id, path, display_name, trusted, created_at, updated_at) VALUES ('p9', '/r9', 'Nine', 0, ?, ?)").run(T, T);
  db.prepare("INSERT INTO messaging_agent_settings (agent_id, accepts_from, cli_messaging, muted) VALUES ('w1', 'group', 1, 0)").run();
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  assert.ok(JOURNAL_SCHEMA_VERSION >= version);
  assert.equal(one(db, "SELECT count(*) FROM messaging_cli_endpoint"), 0);
  assert.equal(journal.cliEndpoint.enabled(), false, "no row is off");
  assert.equal(journal.messages.agentSettings("w1")?.cliMessaging, true, "a worker's own setting is kept and is not the switch");
  assert.equal(one(db, "SELECT count(*) FROM projects WHERE id = 'p9'"), 1);
  db.close();
});

test("the table: one row only (id 1), a closed flag, the user the only writer, a time, never deleted", () => {
  const { db } = setup();
  assert.throws(() => put(db, 2), Error, "id 1 only");
  assert.throws(() => put(db, 0), Error, "id 1 only (below)");
  assert.throws(() => put(db, "one"), Error, "an integer id (STRICT refuses text it cannot convert losslessly)");
  assert.throws(() => put(db, 1, 2), Error, "enabled is 0 or 1");
  assert.throws(() => put(db, 1, "yes"), Error, "enabled is an integer (STRICT)");
  assert.throws(() => put(db, 1, 0.5), Error, "enabled is 0 or 1, not a fraction");
  assert.throws(() => put(db, 1, 1, "plugin:acme"), Error, "the user is the only writer");
  assert.throws(() => put(db, 1, 1, "agent:w1"), Error, "a worker is not a writer");
  assert.throws(() => put(db, 1, 1, "user", "yesterday"), Error, "a time");
  put(db, 1, 1);
  assert.throws(() => put(db, 1, 0), Error, "a second row is refused (the one row is changed, not added)");
  assert.throws(() => db.prepare("UPDATE messaging_cli_endpoint SET changed_by = 'plugin:acme'").run(), Error, "an update keeps the writer the user");
  assert.throws(() => db.prepare("UPDATE messaging_cli_endpoint SET id = 2").run(), Error, "an update keeps id 1");
  db.prepare("UPDATE messaging_cli_endpoint SET enabled = 0, changed_at = ?").run("2026-11-28T00:00:00.000Z");
  assert.throws(() => db.prepare("DELETE FROM messaging_cli_endpoint").run(), Error, "never deleted: off is a 0, so its change is kept");
  assert.equal(one(db, "SELECT count(*) FROM messaging_cli_endpoint"), 1);
  db.close();
});

test("the store: off until the user turns it on; each change writes the row and one ids-free audit event; a repeat changes nothing", () => {
  const { audit, journal } = setup();
  const sw = journal.cliEndpoint;
  assert.equal(sw.enabled(), false);
  assert.deepEqual(sw.set(false), { changed: false }, "off while absent is no change");
  assert.equal(records(audit).length, 0, "and nothing is audited");
  assert.deepEqual(sw.set(true), { changed: true });
  assert.equal(sw.enabled(), true);
  assert.deepEqual(sw.set(true), { changed: false }, "a repeat is no change");
  assert.deepEqual(sw.set(false), { changed: true });
  assert.equal(sw.enabled(), false);
  const rows = records(audit);
  assert.equal(rows.length, 2, "one event per change");
  assert.deepEqual(rows.map((e) => [e.actor, e.target, e.outcome, e.payload]), [
    ["user", "messaging:cli_endpoint", "success", { field: "cli_endpoint", enabled: true }],
    ["user", "messaging:cli_endpoint", "success", { field: "cli_endpoint", enabled: false }],
  ]);
});

test("the store refuses anything but a boolean, writing nothing", () => {
  const { db, audit, journal } = setup();
  for (const v of [1, "true", null, undefined, {}]) {
    assert.throws(() => journal.cliEndpoint.set(v as never), (e: unknown) => (e as { code?: string }).code === "E_INVALID_ARGUMENT", String(v));
  }
  assert.equal(one(db, "SELECT count(*) FROM messaging_cli_endpoint"), 0);
  assert.equal(records(audit).length, 0);
});

test("the row and its audit event are one transaction: an audit that fails leaves the switch as it was", () => {
  const { db } = setup();
  const failing = { append: () => { throw new Error("audit down"); } } as unknown as AuditLog;
  const sw = new CliEndpointSwitchRecords(db, failing, () => T);
  assert.throws(() => sw.set(true), /audit down/);
  assert.equal(sw.enabled(), false, "turning on did not happen without its audit event");
  assert.equal(one(db, "SELECT count(*) FROM messaging_cli_endpoint"), 0);
  db.close();
});
