// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase, runMigrations, schemaVersion, type DatabaseSync } from "@axis/audit";
import { CLI_ACK_LIMITS, CLI_ACK_MIGRATION, JOURNAL_MIGRATIONS, JOURNAL_SCHEMA_VERSION, Journal } from "../src/index.js";

// Acknowledged CLI project-configuration files (PV-M7 slice 1, review 1 SF3/SF4): the table rules, each with a refusing
// case next to the closest accepted value, and the store's replace and read.

const T = "2026-11-26T00:00:00.000Z";
type Val = string | number | null;
const one = (db: DatabaseSync, sql: string, ...a: Val[]): Val => Object.values(db.prepare(sql).get(...a) as Record<string, Val>)[0] as Val;
/** A journal with two CLI workers, w1 and w2 (the table's foreign key needs real workers). */
function withWorkers(): { db: DatabaseSync; journal: Journal } {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  journal.registerProject({ id: "p1", path: "/repo/p1", displayName: "p1", trusted: false, actor: "user" });
  const home = journal.createWorkspace({ projectId: "p1", branch: "axis/home", baseRef: "HEAD", baseSha: "c".repeat(40), createdBy: "user" }).value.id;
  journal.transitionWorkspace(home, "READY");
  for (const w of ["w1", "w2"]) journal.agents.create({ id: w, projectId: "p1", name: w.toUpperCase(), launch: { kind: "cli", entryId: "e" }, homeWorkspaceId: home, groupId: null });
  return { db, journal };
}
const put = (db: DatabaseSync, agent: string, path: string, by = "user", at = T, verb = "INSERT", tail = ""): void =>
  void db.prepare(`${verb} INTO messaging_cli_acknowledged (agent_id, path, acknowledged_by, acknowledged_at) VALUES (?, ?, ?, ?)${tail}`).run(agent, path, by, at);

test("a populated database of the previous version gains the empty table and keeps its rows", () => {
  const version = CLI_ACK_MIGRATION.version;
  const db = openDatabase(":memory:");
  new AuditLog(db);
  runMigrations(db, "journal", JOURNAL_MIGRATIONS.slice(0, version - 1));
  db.prepare("INSERT INTO projects (id, path, display_name, trusted, created_at, updated_at) VALUES ('p9', '/r9', 'Nine', 0, ?, ?)").run(T, T);
  db.prepare("INSERT INTO messaging_agent_settings (agent_id, accepts_from, cli_messaging, muted) VALUES ('w1', 'group', 1, 0)").run();
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  assert.ok(JOURNAL_SCHEMA_VERSION >= version);
  assert.equal(one(db, "SELECT count(*) FROM messaging_cli_acknowledged"), 0);
  assert.equal(journal.messages.agentSettings("w1")?.cliMessaging, true, "an enabled worker keeps its setting and has no acknowledged path yet");
  assert.deepEqual(journal.messages.cliAcknowledged("w1"), []);
  db.close();
});

test("the table: a real worker, closed columns, no NUL, insert once by every verb, at most 16 per worker, never updated", () => {
  const { db } = withWorkers();
  put(db, "w1", ".claude/settings.json");
  assert.throws(() => put(db, "ghost", ".claude/settings.json"), Error, "the worker must exist");
  assert.throws(() => put(db, "w1", "a\0../../../etc/passwd x"), Error, "a NUL is refused (length and GLOB stop at it)");
  for (const [verb, tail] of [["INSERT", ""], ["INSERT OR REPLACE", ""], ["REPLACE", ""], ["INSERT OR IGNORE", ""], ["INSERT", " ON CONFLICT DO NOTHING"]] as const) {
    assert.throws(() => put(db, "w1", ".claude/settings.json", "user", T, verb, tail), Error, `${verb}${tail}`);
  }
  assert.throws(() => put(db, "w1", ".claude/x", "plugin:acme"), Error, "the user is the only writer");
  assert.throws(() => put(db, "w1", ".Claude/x"), Error, "lower case only");
  assert.throws(() => put(db, "w1", ".claude/x y"), Error, "no space");
  assert.throws(() => put(db, "w1", "a".repeat(65)), Error, "at most 64");
  put(db, "w1", "a".repeat(64));
  assert.throws(() => put(db, "w1", ".claude/y", "user", "yesterday"), Error, "a time");
  assert.throws(() => db.prepare("UPDATE messaging_cli_acknowledged SET acknowledged_at = ? WHERE agent_id = 'w1' AND path = '.claude/settings.json'").run("2026-11-27T00:00:00.000Z"), Error, "never updated (one row, so no key collision decides it)");
  for (let i = 2; i < CLI_ACK_LIMITS.pathsPerWorker; i++) put(db, "w1", `p${i}`);
  assert.throws(() => put(db, "w1", "one-too-many"), Error, "at most 16");
  put(db, "w2", "one-too-many");
  db.close();
});

test("the store replaces a worker's acknowledged paths, sorted and unique; an empty list clears them", () => {
  const { db, journal } = withWorkers();
  journal.messages.setCliAcknowledged("w1", [".codex/config.toml", ".claude/settings.json", ".claude/settings.json"]);
  assert.deepEqual(journal.messages.cliAcknowledged("w1"), [".claude/settings.json", ".codex/config.toml"]);
  journal.messages.setCliAcknowledged("w1", [".mcp.json"]);
  assert.deepEqual(journal.messages.cliAcknowledged("w1"), [".mcp.json"]);
  journal.messages.setCliAcknowledged("w1", []);
  assert.deepEqual(journal.messages.cliAcknowledged("w1"), []);
  db.close();
});
