// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase, runMigrations, schemaVersion, type DatabaseSync } from "@axis/audit";
import { JOURNAL_MIGRATIONS, JOURNAL_SCHEMA_VERSION, Journal } from "../src/index.js";

// Runs of agents and the upgrade to schema version 12 (ticket PV-G1, ADR 0006 decision 5).

const T = "2026-11-21T00:00:00.000Z";
const BEFORE = JOURNAL_MIGRATIONS.slice(0, 11);

function readyWorkspace(journal: Journal, projectId = "p1"): string {
  const branch = `axis/w${Math.random().toString(36).slice(2, 8)}`;
  const id = journal.createWorkspace({ projectId, branch, baseRef: "HEAD", baseSha: "c".repeat(40), createdBy: "user" }).value.id;
  journal.transitionWorkspace(id, "READY");
  return id;
}
function open(db: DatabaseSync = openDatabase(":memory:")): Journal {
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  if (journal.getProject("p1") === undefined) journal.registerProject({ id: "p1", path: "/repo/one", displayName: "One", trusted: true, actor: "user" });
  return journal;
}
function addAgent(db: DatabaseSync, id: string, home: string, kind: "composer" | "cli"): void {
  const launch = kind === "cli" ? ["e1", null, null, null] : [null, "conn", "model", "agent"];
  db.prepare(
    "INSERT INTO agents (id, project_id, name, kind, cli_entry_id, connection, model_id, default_mode, home_workspace_id, created_by, created_at, updated_at) " +
      "VALUES (?, 'p1', ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?)",
  ).run(id, `name ${id}`, kind, ...launch, home, T, T);
}
let runSeq = 0;
function addRun(db: DatabaseSync, workspaceId: string, kind: string, agentId: string | null): string {
  const id = `r${++runSeq}`;
  db.prepare("INSERT INTO agent_runs (id, workspace_id, kind, state, created_at, updated_at, agent_id) VALUES (?, ?, ?, 'QUEUED', ?, ?, ?)")
    .run(id, workspaceId, kind, T, T, agentId);
  return id;
}
const agentOf = (db: DatabaseSync, runId: string): unknown => (db.prepare("SELECT agent_id FROM agent_runs WHERE id = ?").get(runId) as { agent_id: unknown }).agent_id;

test("a run of an agent starts in its home workspace, with its kind, while the agent is live; its agent never changes", () => {
  const db = openDatabase(":memory:");
  const journal = open(db);
  const [home, elsewhere] = [readyWorkspace(journal), readyWorkspace(journal)];
  addAgent(db, "a1", home, "composer");
  addAgent(db, "c1", home, "cli");
  addAgent(db, "a2", elsewhere, "composer");
  const plain = journal.createRun({ workspaceId: home, kind: "cli", createdBy: "user" }).value.id;
  assert.equal(agentOf(db, plain), null, "today's run path records no agent");
  const r1 = addRun(db, home, "composer", "a1");
  addRun(db, home, "cli", "c1");
  assert.equal(agentOf(db, r1), "a1");
  assert.throws(() => addRun(db, elsewhere, "composer", "a1"), /home workspace, with its kind/);
  assert.throws(() => addRun(db, home, "cli", "a1"), /home workspace, with its kind/);
  assert.throws(() => addRun(db, home, "composer", "nobody"), /home workspace, with its kind/);
  db.prepare("UPDATE agents SET archived = 1, archived_at = 'now' WHERE id = 'a2'").run();
  assert.throws(() => addRun(db, elsewhere, "composer", "a2"), /home workspace, with its kind/);
  for (const [run, to] of [[plain, "'a1'"], [r1, "NULL"], [r1, "'a2'"]] as const) {
    assert.throws(() => db.prepare(`UPDATE agent_runs SET agent_id = ${to} WHERE id = ?`).run(run), /keeps the agent it started with/);
  }
  db.prepare("UPDATE agent_runs SET state = 'RUNNING', agent_id = 'a1' WHERE id = ?").run(r1);
  db.prepare("PRAGMA foreign_keys = OFF").run();
  db.prepare("DROP TRIGGER agent_runs_agent_match").run();
  db.prepare("PRAGMA foreign_keys = ON").run();
  assert.throws(() => addRun(db, home, "composer", "ghost"), /FOREIGN KEY/, "the column is a foreign key as well");
  db.close();
});

function schemaOf(db: DatabaseSync): unknown[] {
  return (db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all() as unknown[]).map((r) => ({ ...(r as object) }));
}

test("upgrading a version 11 database keeps its runs with no agent; a failed upgrade leaves version 11 untouched", () => {
  const db = openDatabase(":memory:");
  runMigrations(db, "journal", BEFORE);
  assert.equal(schemaVersion(db, "journal"), 11);
  db.prepare("INSERT INTO projects (id, path, display_name, trusted, created_at, updated_at) VALUES ('p1', '/repo/one', 'One', 1, ?, ?)").run(T, T);
  db.prepare("INSERT INTO agent_workspaces (id, project_id, branch, base_ref, base_sha, created_by, state, created_at, updated_at) VALUES ('w1', 'p1', 'axis/a', 'HEAD', ?, 'user', 'READY', ?, ?)")
    .run("c".repeat(40), T, T);
  db.prepare("INSERT INTO agent_runs (id, workspace_id, kind, state, created_at, updated_at) VALUES ('old', 'w1', 'cli', 'COMPLETED', ?, ?)").run(T, T);
  const before = schemaOf(db);
  const v12 = JOURNAL_MIGRATIONS[11];
  assert.ok(v12 !== undefined && v12.version === 12);
  assert.throws(() => runMigrations(db, "journal", [...BEFORE, { version: 12, sql: `${v12.sql}; INSERT INTO agents (id) VALUES (NULL);` }]));
  assert.equal(schemaVersion(db, "journal"), 11);
  assert.deepEqual(schemaOf(db), before);
  const journal = open(db);
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  assert.equal(agentOf(db, "old"), null);
  assert.equal(journal.getRun("old")?.state, "COMPLETED");
  assert.throws(() => db.prepare("UPDATE agent_runs SET agent_id = 'x' WHERE id = 'old'").run(), /keeps the agent/);
  addAgent(db, "a1", "w1", "cli");
  addRun(db, "w1", "cli", "a1");
  db.close();
});

test("upgrading a version 10 database applies 11 and 12 in order", () => {
  const db = openDatabase(":memory:");
  runMigrations(db, "journal", JOURNAL_MIGRATIONS.slice(0, 10));
  db.prepare("INSERT INTO projects (id, path, display_name, trusted, created_at, updated_at) VALUES ('p1', '/repo/one', 'One', 0, ?, ?)").run(T, T);
  open(db);
  assert.equal(schemaVersion(db, "journal"), 12);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('agents','agent_groups')").all() as { name: string }[]).map((r) => r.name).sort();
  assert.deepEqual(tables, ["agent_groups", "agents"]);
  db.close();
});
