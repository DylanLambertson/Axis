// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase, runMigrations, schemaVersion, type DatabaseSync } from "@axis/audit";
import { INDEX_LOCKS_MIGRATION, JOURNAL_MIGRATIONS, JOURNAL_SCHEMA_VERSION, Journal } from "../src/index.js";

// The index locks Axis holds (DC-0b, RR-98; `docs/design/own-shell-plan.md` DC-0b): schema version 21. One row per lock
// path while the post-commit index refresh holds it, so a startup sweep removes only a lock Axis made. Each table rule has a
// refusing case next to the closest accepted value; the store records, re-records, clears and lists.

const T = "2026-11-27T00:00:00.000Z";
const LOCK = "/repo/.git/index.lock";
type Val = string | number | null;
const one = (db: DatabaseSync, sql: string, ...a: Val[]): Val => Object.values(db.prepare(sql).get(...a) as Record<string, Val>)[0] as Val;
const open = (): { db: DatabaseSync; journal: Journal } => {
  const db = openDatabase(":memory:");
  return { db, journal: Journal.open(db, { audit: new AuditLog(db), now: () => new Date(T) }) };
};
const put = (db: DatabaseSync, over: Record<string, Val> = {}, verb = "INSERT"): void => {
  const row: Record<string, Val> = { path: LOCK, dev: "2049", ino: "39289545", mtime_ns: "1795812251102264600", recorded_at: T, ...over };
  const cols = Object.keys(row);
  db.prepare(`${verb} INTO index_locks (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...Object.values(row));
};

test("a populated version 20 journal gains the empty table", () => {
  const db = openDatabase(":memory:");
  new AuditLog(db);
  runMigrations(db, "journal", JOURNAL_MIGRATIONS.slice(0, INDEX_LOCKS_MIGRATION.version - 1));
  db.prepare("INSERT INTO projects (id, path, display_name, trusted, created_at, updated_at) VALUES ('p9', '/r9', 'Nine', 0, ?, ?)").run(T, T);
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  assert.ok(JOURNAL_SCHEMA_VERSION >= INDEX_LOCKS_MIGRATION.version);
  assert.deepEqual(journal.indexLocks.list(), []);
  assert.equal(one(db, "SELECT count(*) FROM projects"), 1);
});

test("the table: an absolute path ending in index.lock without NUL, decimal ids and time, one row per path by every verb", () => {
  const { db } = open();
  put(db);
  for (const verb of ["INSERT", "INSERT OR REPLACE", "REPLACE", "INSERT OR IGNORE"]) assert.throws(() => put(db, {}, verb), Error, verb);
  for (const [col, bad] of [
    ["path", "relative/index.lock"], ["path", "/repo/.git/index"], ["path", "/repo/.git/index.lock\0x"], ["path", `/${"a".repeat(4096)}/index.lock`],
    ["dev", "-1"], ["dev", "12a"], ["dev", ""], ["ino", "1e5"], ["mtime_ns", " 1"], ["recorded_at", "yesterday"],
  ] as const) {
    assert.throws(() => put(db, { path: "/other/.git/index.lock", [col]: bad }), Error, `${col} ${JSON.stringify(bad)}`);
  }
  put(db, { path: "C:\\repo\\.git\\index.lock" });
  put(db, { path: "/repo/.git/worktrees/w/index.lock", dev: "0", ino: "0", mtime_ns: "0" });
  assert.equal(one(db, "SELECT count(*) FROM index_locks"), 3);
});

test("the store: record, record again for the same path (the new inode after git rewrote the lock), clear, list", () => {
  const { journal } = open();
  journal.indexLocks.record({ path: LOCK, dev: 2049n, ino: 39289545n, mtimeNs: 1795812251102264600n });
  journal.indexLocks.record({ path: LOCK, dev: 2049n, ino: 39289546n, mtimeNs: 1795812251202264600n });
  assert.deepEqual(journal.indexLocks.list(), [{ path: LOCK, dev: 2049n, ino: 39289546n, mtimeNs: 1795812251202264600n }], "kills a second row or a kept first inode");
  journal.indexLocks.clear(LOCK);
  journal.indexLocks.clear(LOCK);
  assert.deepEqual(journal.indexLocks.list(), [], "clearing twice is fine");
  assert.throws(() => journal.indexLocks.record({ path: "relative", dev: 1n, ino: 1n, mtimeNs: 1n }));
  assert.throws(() => journal.indexLocks.record({ path: LOCK, dev: -1n, ino: 1n, mtimeNs: 1n }));
});
