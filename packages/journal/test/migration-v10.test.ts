// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase, runMigrations, schemaVersion, type DatabaseSync } from "@axis/audit";
import { JOURNAL_MIGRATIONS, JOURNAL_SCHEMA_VERSION, Journal } from "../src/index.js";

// Message delivery into runs (ticket PV-M3 slice 2): schema version 10, forward-only, additive.

const V9 = JOURNAL_MIGRATIONS.slice(0, 9);
const id = (kind: "thr" | "msg", n: number): string => `${kind}_${String(n).padStart(21, "0")}A`;
const T1 = id("thr", 1);

function setup(db: DatabaseSync = openDatabase(":memory:")): { db: DatabaseSync; journal: Journal; runs: string[] } {
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  if (journal.getProject("p1") === undefined) journal.registerProject({ id: "p1", path: "/repo/one", displayName: "One", trusted: true, actor: "user" });
  const ws = journal.createWorkspace({ projectId: "p1", branch: `axis/w${journal.listProjects().length}${Math.random().toString(36).slice(2, 6)}`, baseRef: "HEAD", baseSha: "c".repeat(40), createdBy: "user" }).value.id;
  journal.transitionWorkspace(ws, "READY");
  const runs = [0, 1].map(() => journal.composer.createRun({ workspaceId: ws, createdBy: "user" }, { mode: "agent", providerId: "mock", modelId: "mock-model" }).value.id);
  return { db, journal, runs };
}
function post(journal: Journal, n: number, create = n === 1): void {
  journal.messages.append({
    thread: create ? { create: true, id: T1, projectId: "p1" } : { create: false, id: T1 },
    join: create ? ["user", "agent:a1"] : [],
    message: { id: id("msg", n), sender: { kind: "user", verified: true }, senderKey: "user", recipients: [{ agent: "a1" }], expanded: [{ kind: "agent", agentId: "a1" }], body: `m${n}`, refs: [], inReplyTo: null, hop: 0 },
    to: [{ principal: "agent:a1", counted: false }],
  });
}

test("version 10: pending, lease once, ack once, release only leases; a delivery only moves from leased to acked", () => {
  const { db, journal, runs } = setup();
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  const d = journal.messages.deliveries;
  post(journal, 1);
  post(journal, 2);
  assert.deepEqual(d.pending("agent:a1", 10).map((p) => p.seq), [1, 2]);
  assert.deepEqual(d.pending("agent:a2", 10), []);
  assert.equal(d.lease(id("msg", 1), "agent:a1", runs[0]!), true);
  assert.equal(d.lease(id("msg", 1), "agent:a1", runs[1]!), false, "one delivery per message and recipient");
  assert.deepEqual(d.pending("agent:a1", 10).map((p) => p.seq), [2]);
  assert.equal(d.ack(runs[1]!, [id("msg", 1)]), 0, "another run cannot ack it");
  assert.equal(d.ack(runs[0]!, [id("msg", 1)]), 1);
  assert.equal(d.ack(runs[0]!, [id("msg", 1)]), 0);
  d.lease(id("msg", 2), "agent:a1", runs[0]!);
  assert.equal(d.releaseLeases(), 1);
  assert.deepEqual(d.get(id("msg", 1), "agent:a1"), { runId: runs[0], state: "acked" });
  assert.equal(d.get(id("msg", 2), "agent:a1"), undefined);
  assert.throws(() => db.prepare("UPDATE message_deliveries SET state = 'leased', acked_at = NULL").run(), /only moves/);
  assert.throws(() => db.prepare("UPDATE message_deliveries SET acked_at = 'later'").run(), /only moves/);
  assert.throws(() => d.lease(id("msg", 2), "agent:a1", "no-such-run"), "a delivery names a real run");
  assert.throws(() => d.lease(id("msg", 2), "a b", runs[0]!), "a principal is a key");
  assert.throws(() => d.pending("agent:a1", 0));
  db.close();
});

test("upgrading a version 9 database keeps its messages and adds the delivery table; a failed upgrade leaves version 9", () => {
  const db = openDatabase(":memory:");
  runMigrations(db, "journal", V9);
  const schemaOf = (): unknown[] => (db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all() as unknown[]).map((r) => ({ ...(r as object) }));
  const before = schemaOf();
  const v10 = JOURNAL_MIGRATIONS[9];
  assert.ok(v10 !== undefined && v10.version === 10);
  assert.throws(() => runMigrations(db, "journal", [...V9, { version: 10, sql: `${v10.sql}; INSERT INTO message_deliveries (message_id) VALUES (NULL);` }]));
  assert.equal(schemaVersion(db, "journal"), 9);
  assert.deepEqual(schemaOf(), before);
  const { journal } = setup(db);
  post(journal, 1);
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  assert.equal(journal.messages.deliveries.pending("agent:a1", 5).length, 1);
  db.close();
});
