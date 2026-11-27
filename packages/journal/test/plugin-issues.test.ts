// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AuditLog, openDatabase, runMigrations, schemaVersion, type DatabaseSync } from "@axis/audit";
import { JOURNAL_MIGRATIONS, JOURNAL_SCHEMA_VERSION, Journal, PLUGIN_ISSUE_LIMITS } from "../src/index.js";

// The plugin challenge counter (PV-K1e-a2, schema version 17): the table rules, each with a refusing case next to the closest
// accepted value, and the store's hourly count across a disable and enable, a reopen, a prune and a clock that steps back.

const H = PLUGIN_ISSUE_LIMITS.windowMs;
const DAY = PLUGIN_ISSUE_LIMITS.keepMs;
const T0 = 1_800_000_000_000;
type Row = Record<string, string | number | null>;

function open(path = ":memory:"): { db: DatabaseSync; journal: Journal } {
  const db = openDatabase(path);
  return { db, journal: Journal.open(db, { audit: new AuditLog(db) }) };
}
function setup(): { db: DatabaseSync; journal: Journal } {
  const s = open();
  s.journal.registerProject({ id: "p1", path: "/repo/one", displayName: "One", trusted: false, actor: "user" });
  s.journal.plugins.add("acme.board", "p1");
  s.journal.plugins.add("other.tool", "p1");
  return s;
}
const n = (db: DatabaseSync, where = "1 = 1"): number => Number((db.prepare(`SELECT count(*) AS n FROM plugin_challenge_issues WHERE ${where}`).get() as Row)["n"]);
const put = (db: DatabaseSync, at: number, plugin = "acme.board", verb = "INSERT", seq?: number): void => {
  if (seq === undefined) db.prepare(`${verb} INTO plugin_challenge_issues (plugin_id, project_id, issued_at) VALUES (?, 'p1', ?)`).run(plugin, at);
  else db.prepare(`${verb} INTO plugin_challenge_issues (seq, plugin_id, project_id, issued_at) VALUES (?, ?, 'p1', ?)`).run(seq, plugin, at);
};
const fill = (journal: Journal, at: number, count: number = PLUGIN_ISSUE_LIMITS.perHour, plugin = "acme.board"): void => {
  for (let i = 0; i < count; i++) assert.deepEqual(journal.pluginIssues.record(plugin, "p1", at + i), { ok: true }, `issue ${i}`);
};

test("version 17: a populated version 16 database gains the empty table and keeps its rows", () => {
  const db = openDatabase(":memory:");
  new AuditLog(db);
  runMigrations(db, "journal", JOURNAL_MIGRATIONS.slice(0, 16));
  db.prepare("INSERT INTO projects (id, path, display_name, trusted, created_at, updated_at) VALUES ('p9', '/r9', 'Nine', 0, ?, ?)").run("2026-11-26T00:00:00.000Z", "2026-11-26T00:00:00.000Z");
  Journal.open(db, { audit: new AuditLog(db) });
  assert.ok(JOURNAL_SCHEMA_VERSION >= 17); // a later version is added after it (v18: the acknowledged CLI files)
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION, "opened at the latest version");
  assert.equal(n(db), 0);
  assert.equal(Number((db.prepare("SELECT count(*) AS n FROM projects WHERE id = 'p9'").get() as Row)["n"]), 1);
});

test("table rules: a known plugin only, ids checked, times in range and only growing, a row inserted once and never changed", () => {
  const { db } = setup();
  assert.throws(() => put(db, T0, "nobody.here"), /needs the plugin/);
  assert.throws(() => put(db, T0, "Acme"), Error);
  assert.throws(() => put(db, -1), Error);
  assert.throws(() => put(db, 8_640_000_000_000_001), /CHECK/, "past the last valid date");
  put(db, T0, "acme.board", "INSERT", 5);
  for (const verb of ["INSERT", "INSERT OR REPLACE", "REPLACE", "INSERT OR IGNORE"]) assert.throws(() => put(db, T0 + 1, "acme.board", verb, 5), /inserted once/, verb);
  assert.throws(() => put(db, T0 - 1), /only grow/, "older than the newest row");
  put(db, T0); // equal to the newest is accepted
  assert.throws(() => db.prepare("UPDATE plugin_challenge_issues SET issued_at = issued_at + 1").run(), /never changes/);
  assert.throws(() => db.prepare("UPDATE plugin_challenge_issues SET plugin_id = 'other.tool'").run(), /never changes/);
  assert.equal(n(db), 2);
});

test("a delete is refused unless the row is more than 24 hours older than the newest row", () => {
  const { db } = setup();
  put(db, T0);
  put(db, T0 + 1);
  put(db, T0 + DAY); // newest: the row at T0 is exactly 24 h older (kept), the one at T0 + 1 is younger (kept)
  assert.throws(() => db.prepare("DELETE FROM plugin_challenge_issues WHERE issued_at = ?").run(T0), /only rows more than 24 hours/);
  assert.throws(() => db.prepare("DELETE FROM plugin_challenge_issues WHERE issued_at = ?").run(T0 + DAY), /only rows more than 24 hours/);
  put(db, T0 + DAY + 1);
  db.prepare("DELETE FROM plugin_challenge_issues WHERE issued_at = ?").run(T0); // now 24 h + 1 ms older: pruned
  assert.equal(n(db), 3);
});

test("the row cap refuses an insert past it; the store answers issue_cap and records nothing", () => {
  const { db, journal } = setup();
  db.exec("BEGIN");
  const ins = db.prepare("INSERT INTO plugin_challenge_issues (plugin_id, project_id, issued_at) VALUES ('other.tool', 'p1', ?)");
  for (let i = 0; i < PLUGIN_ISSUE_LIMITS.rows - 1; i++) ins.run(T0);
  db.exec("COMMIT");
  put(db, T0); // the last row the cap allows
  assert.throws(() => put(db, T0), /plugin_issue_cap/);
  assert.deepEqual(journal.pluginIssues.record("acme.board", "p1", T0 + 1), { ok: false, reason: "issue_cap" });
  assert.equal(n(db), PLUGIN_ISSUE_LIMITS.rows);
});

test("record: 6 per plugin and project in any hour, the 7th refused with nothing recorded; another plugin counts apart", () => {
  const { db, journal } = setup();
  fill(journal, T0);
  assert.deepEqual(journal.pluginIssues.record("acme.board", "p1", T0 + 10), { ok: false, reason: "hourly_limit" });
  assert.equal(n(db), 6);
  assert.deepEqual(journal.pluginIssues.record("other.tool", "p1", T0 + 10), { ok: true });
  // The window is one hour from the first issue: at T0 + H the first row has left it; one millisecond earlier it has not.
  assert.deepEqual(journal.pluginIssues.record("acme.board", "p1", T0 + H - 1), { ok: false, reason: "hourly_limit" });
  assert.deepEqual(journal.pluginIssues.record("acme.board", "p1", T0 + H), { ok: true });
  assert.deepEqual(journal.pluginIssues.record("nobody.here", "p1", T0 + H), { ok: false, reason: "unknown_plugin" });
  assert.throws(() => journal.pluginIssues.record("acme.board", "p1", -1), RangeError);
  assert.throws(() => journal.pluginIssues.record("acme.board", "p1", 1.5), RangeError);
  // Past the table's last valid date, and any time inLastHour is given that record would refuse: a closed RangeError.
  assert.throws(() => journal.pluginIssues.record("acme.board", "p1", PLUGIN_ISSUE_LIMITS.maxMs + 1), RangeError);
  for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, PLUGIN_ISSUE_LIMITS.maxMs + 1]) assert.throws(() => journal.pluginIssues.inLastHour("acme.board", "p1", bad), RangeError, String(bad));
});

test("a disable and enable, and a revoke, do not reset the count", () => {
  const { journal } = setup();
  journal.plugins.setEnabled("acme.board", "p1", true);
  journal.plugins.grant("acme.board", "p1", "runs.start");
  fill(journal, T0);
  journal.plugins.setEnabled("acme.board", "p1", false);
  journal.plugins.setEnabled("acme.board", "p1", true);
  journal.plugins.revoke("acme.board", "p1", "runs.start");
  journal.plugins.grant("acme.board", "p1", "runs.start");
  assert.deepEqual(journal.pluginIssues.record("acme.board", "p1", T0 + 100), { ok: false, reason: "hourly_limit" });
  assert.equal(journal.pluginIssues.inLastHour("acme.board", "p1", T0 + 100), 6);
});

test("a restart (the database reopened) does not reset the count", () => {
  const dir = mkdtempSync(join(process.env["TMPDIR"] ?? "/tmp", "axis-issues-"));
  try {
    const path = join(dir, "journal.db");
    const first = open(path);
    first.journal.registerProject({ id: "p1", path: "/repo/one", displayName: "One", trusted: false, actor: "user" });
    first.journal.plugins.add("acme.board", "p1");
    fill(first.journal, T0);
    first.db.close();
    const again = open(path);
    assert.deepEqual(again.journal.pluginIssues.record("acme.board", "p1", T0 + 100), { ok: false, reason: "hourly_limit" });
    again.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a prune never shortens the hour: it removes only rows a day older than the newest, and the count stays", () => {
  const { db, journal } = setup();
  fill(journal, T0, 3, "other.tool"); // old rows: pruned once a day has passed
  fill(journal, T0 + DAY + 10);
  assert.equal(n(db, "plugin_id = 'other.tool'"), 0, "the record call pruned the day-old rows");
  assert.deepEqual(journal.pluginIssues.record("acme.board", "p1", T0 + DAY + 20), { ok: false, reason: "hourly_limit" });
  assert.equal(n(db, "plugin_id = 'acme.board'"), 6);
});

test("a system clock that steps back across a prune opens no fresh hour: the time is clamped to the newest row", () => {
  const { db, journal } = setup();
  fill(journal, T0, 2, "other.tool");
  fill(journal, T0 + DAY + H); // the six of this hour; the record calls pruned the day-old rows
  assert.equal(n(db, "plugin_id = 'other.tool'"), 0);
  // The clock steps back two days: the call is counted at the newest row's time, so the six still count and nothing is pruned.
  assert.deepEqual(journal.pluginIssues.record("acme.board", "p1", T0 - DAY), { ok: false, reason: "hourly_limit" });
  assert.equal(journal.pluginIssues.inLastHour("acme.board", "p1", T0 - DAY), 6);
  assert.equal(n(db, "plugin_id = 'acme.board'"), 6);
  // Another plugin's issue during the step back is recorded at the clamped time, never before the newest row.
  assert.deepEqual(journal.pluginIssues.record("other.tool", "p1", T0 - DAY), { ok: true });
  assert.equal(Number((db.prepare("SELECT issued_at AS t FROM plugin_challenge_issues WHERE plugin_id = 'other.tool'").get() as Row)["t"]), T0 + DAY + H + 5);
});

test("a row between one hour and a day old is kept by a record call, which succeeds", () => {
  const { db, journal } = setup();
  fill(journal, T0, 1);
  // Two hours on: the row no longer counts for the hour, but it is less than a day old, so the prune must leave it.
  assert.deepEqual(journal.pluginIssues.record("acme.board", "p1", T0 + 2 * H), { ok: true });
  assert.equal(n(db, `issued_at = ${T0}`), 1, "the two-hour-old row stays");
  assert.equal(journal.pluginIssues.inLastHour("acme.board", "p1", T0 + 2 * H), 1);
});

test("no cascade: the counter's foreign key is NO ACTION, and a plugin row with issues can never be deleted", () => {
  const { db, journal } = setup();
  fill(journal, T0, 1);
  const fks = (db.prepare("PRAGMA foreign_key_list(plugin_challenge_issues)").all() as Row[]).map((r) => [r["table"], r["on_delete"], r["on_update"]]);
  assert.deepEqual(fks, [["plugin_enablement", "NO ACTION", "NO ACTION"], ["plugin_enablement", "NO ACTION", "NO ACTION"]]);
  assert.throws(() => db.prepare("DELETE FROM plugin_enablement WHERE plugin_id = 'acme.board'").run(), /never deleted/);
  assert.equal(n(db), 1);
});

test("residual RR-94 pinned: a row dated in the future holds every later issue at its time, fails closed, and cannot be repaired in product", () => {
  const { db, journal } = setup();
  const FUTURE = T0 + 400 * DAY; // the host clock stepped forward for one call
  assert.deepEqual(journal.pluginIssues.record("other.tool", "p1", FUTURE), { ok: true });
  // The clock is back: every later issue of every plugin is clamped to FUTURE, so acme gets six in total, then nothing.
  fill(journal, T0 + 10);
  assert.deepEqual(journal.pluginIssues.record("acme.board", "p1", T0 + 2 * DAY), { ok: false, reason: "hourly_limit" });
  assert.equal(n(db, `plugin_id = 'acme.board' AND issued_at = ${FUTURE}`), 6);
  // No in-product repair: the future row and the held rows cannot be deleted or moved.
  assert.throws(() => db.prepare("DELETE FROM plugin_challenge_issues WHERE issued_at = ?").run(FUTURE), /only rows more than 24 hours/);
  assert.throws(() => db.prepare("UPDATE plugin_challenge_issues SET issued_at = ?").run(T0), /never changes/);
  // Once the real time passes the future row by an hour, the plugin is counted afresh.
  assert.deepEqual(journal.pluginIssues.record("acme.board", "p1", FUTURE + H + 6), { ok: true });
});
