// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { AuditLog, AxisError, acquireInstanceLock, openDatabase } from "@axis/audit";
import { userPrincipal } from "../src/daemon-principal.js";
import { Journal, WORKSPACE_TRANSITIONS } from "../src/index.js";

const USER = userPrincipal();
const SHA = "b".repeat(40);
const SHA2 = "c".repeat(40);
const TREE = "d".repeat(40);
const code = (c: string) => (e: unknown) => e instanceof AxisError && e.code === c;
const LOCK_DIR = mkdtempSync(join(tmpdir(), "axis-journal-records-"));
const LOCK = acquireInstanceLock(LOCK_DIR);
after(() => {
  LOCK.release();
  rmSync(LOCK_DIR, { recursive: true, force: true });
});
// An absolute, normalised path on whatever OS runs the test.
const abs = (...parts: string[]): string => resolve(LOCK_DIR, ...parts);

function setup() {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db);
  const journal = Journal.open(db, { audit });
  const id = journal.createWorkspace({ projectId: "p", branch: "axis/x", baseRef: "main", baseSha: SHA, createdBy: "user" }).value.id;
  return { db, audit, journal, id };
}
const ready = (s: ReturnType<typeof setup>) => s.journal.transitionWorkspace(s.id, "READY");

test("FINALISED: READY to FINALISED needs an outcome, FINALISED to REMOVING to REMOVED, and the names match worktrees and the protocol", () => {
  const s = setup();
  ready(s);
  assert.deepEqual([...WORKSPACE_TRANSITIONS.READY].sort(), ["FINALISED", "REMOVING"]);
  assert.throws(() => s.journal.transitionWorkspace(s.id, "FINALISED"), code("E_INVALID_ARGUMENT"));
  assert.throws(() => s.journal.transitionWorkspace(s.id, "REMOVING", { outcome: "merged" }), code("E_INVALID_ARGUMENT"));
  const fin = s.journal.transitionWorkspace(s.id, "FINALISED", { outcome: "archived" });
  assert.equal(fin.state, "FINALISED");
  assert.equal(fin.finaliseOutcome, "archived");
  assert.throws(() => s.journal.createRun({ workspaceId: s.id, kind: "cli", createdBy: "user" }), code("E_CONFLICT"));
  s.journal.transitionWorkspace(s.id, "REMOVING");
  const gone = s.journal.transitionWorkspace(s.id, "REMOVED");
  assert.equal(gone.finaliseOutcome, "archived", "the outcome is kept");
  assert.deepEqual(s.journal.transitions("workspace", s.id).map((t) => t.to), ["CREATING", "READY", "FINALISED", "REMOVING", "REMOVED"]);
});

test("a workspace with unfinished runs cannot be finalised", () => {
  const s = setup();
  ready(s);
  s.journal.createRun({ workspaceId: s.id, kind: "cli", createdBy: "user" });
  assert.throws(() => s.journal.transitionWorkspace(s.id, "FINALISED", { outcome: "merged" }), code("E_CONFLICT"));
  assert.equal(s.journal.getWorkspace(s.id)?.state, "READY");
});

test("a refused removal falls back only to the state it started from", () => {
  const s = setup();
  ready(s);
  s.journal.transitionWorkspace(s.id, "FINALISED", { outcome: "merged" });
  s.journal.transitionWorkspace(s.id, "REMOVING");
  assert.throws(() => s.journal.transitionWorkspace(s.id, "READY"), code("E_CONFLICT"));
  assert.equal(s.journal.transitionWorkspace(s.id, "FINALISED").finaliseOutcome, "merged");
  // And the other way: a READY removal does not become FINALISED.
  const s2 = setup();
  ready(s2);
  s2.journal.transitionWorkspace(s2.id, "REMOVING");
  assert.throws(() => s2.journal.transitionWorkspace(s2.id, "FINALISED"), code("E_CONFLICT"));
  assert.equal(s2.journal.transitionWorkspace(s2.id, "READY").state, "READY");
});

test("projects: register, read, list; a duplicate id or path is a conflict and writes no audit event", () => {
  const { journal, audit } = setup();
  const p = journal.registerProject({ id: "proj-1", path: abs("repo"), displayName: "Repo", trusted: false, actor: "user" });
  assert.deepEqual({ ...p, createdAt: "", updatedAt: "" }, { id: "proj-1", path: abs("repo"), displayName: "Repo", trusted: false, createdAt: "", updatedAt: "" });
  assert.equal(journal.getProject("proj-1")?.path, abs("repo"));
  assert.deepEqual(journal.listProjects().map((x) => x.id), ["proj-1"]);
  const head = audit.head();
  assert.throws(() => journal.registerProject({ id: "proj-1", path: abs("other"), displayName: "x", trusted: true, actor: "user" }), code("E_CONFLICT"));
  assert.throws(() => journal.registerProject({ id: "proj-2", path: abs("repo"), displayName: "x", trusted: true, actor: "user" }), code("E_CONFLICT"));
  assert.deepEqual(audit.head(), head);
  for (const path of ["relative/dir", `${abs("a")}${"/".repeat(2)}b`, `${abs("a")}\u0000`, "", "x".repeat(5000)]) {
    assert.throws(() => journal.registerProject({ id: "proj-3", path, displayName: "x", trusted: true, actor: "user" }), code("E_INVALID_ARGUMENT"), path.slice(0, 20));
  }
  assert.throws(() => journal.registerProject({ id: "p", path: abs("z"), displayName: "x", trusted: true, actor: "someone" as never }), code("E_INVALID_ARGUMENT"));
});

test("worktree path is recorded once, only while creating or ready, and is audited without its value", () => {
  const s = setup();
  const before = s.audit.head()?.seq ?? 0;
  assert.equal(s.journal.setWorktreePath(s.id, abs("wt"), "daemon").worktreePath, abs("wt"));
  assert.equal(s.journal.setWorktreePath(s.id, abs("wt"), "daemon").worktreePath, abs("wt"), "same value again is a no-op");
  assert.throws(() => s.journal.setWorktreePath(s.id, abs("elsewhere"), "daemon"), code("E_CONFLICT"));
  assert.throws(() => s.journal.setWorktreePath(s.id, "../escape", "daemon"), code("E_INVALID_ARGUMENT"));
  assert.throws(() => s.journal.setWorktreePath("missing", abs("wt"), "daemon"), code("E_NOT_FOUND"));
  const events = s.audit.list({ afterSeq: before });
  assert.equal(events.length, 1);
  assert.ok(!JSON.stringify(events).includes(abs("wt")), "the path is not stored in the audit payload");
  assert.equal(s.audit.verify().ok, true);
  ready(s);
  s.journal.transitionWorkspace(s.id, "REMOVING");
  assert.throws(() => s.journal.setWorktreePath(s.id, abs("wt"), "daemon"), code("E_CONFLICT"));
});

test("last pushed sha and reviewed tree hash are validated, state-gated and audited in the same transaction", () => {
  const s = setup();
  assert.throws(() => s.journal.recordPushed(s.id, SHA, "daemon"), code("E_CONFLICT"), "not before READY");
  ready(s);
  assert.equal(s.journal.getWorkspace(s.id)?.lastPushedSha, null);
  for (const bad of ["", "ABC", "g".repeat(40), SHA.toUpperCase(), "a".repeat(39), `${SHA}\n`]) {
    assert.throws(() => s.journal.recordPushed(s.id, bad, "daemon"), code("E_INVALID_ARGUMENT"));
    assert.throws(() => s.journal.recordReviewedTree(s.id, bad, USER), code("E_INVALID_ARGUMENT"));
  }
  const n = s.audit.head()?.seq ?? 0;
  assert.equal(s.journal.recordPushed(s.id, SHA2, "daemon").lastPushedSha, SHA2);
  const r = s.journal.recordReviewedTree(s.id, TREE, USER);
  assert.equal(r.reviewedTreeHash, TREE);
  assert.ok(r.reviewedAt);
  assert.equal(s.audit.head()?.seq, n + 2);
  assert.equal(s.audit.verify().ok, true);
  s.journal.transitionWorkspace(s.id, "FINALISED", { outcome: "merged" });
  assert.equal(s.journal.recordPushed(s.id, SHA, "daemon").lastPushedSha, SHA);
  assert.throws(() => s.journal.recordReviewedTree(s.id, TREE, USER), code("E_CONFLICT"), "review only while READY");
});

test("an audit failure rolls the record back (journal-first: the row and its event commit together)", () => {
  const s = setup();
  ready(s);
  s.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'no'); END");
  assert.throws(() => s.journal.recordPushed(s.id, SHA, "daemon"));
  assert.equal(s.journal.getWorkspace(s.id)?.lastPushedSha, null);
  assert.equal(s.db.isTransaction, false);
});

test("lock state: take, refuse a second, release; recovery clears one a dead process left, audited once", () => {
  const s = setup();
  ready(s);
  const locked = s.journal.lockWorkspace(s.id, "daemon");
  assert.equal(locked.lockState, "locked");
  assert.ok(locked.lockedAt);
  assert.throws(() => s.journal.lockWorkspace(s.id, "daemon"), code("E_CONFLICT"));
  const r = s.journal.recover(LOCK);
  assert.deepEqual(r.locksCleared, [s.id]);
  assert.equal(s.journal.getWorkspace(s.id)?.lockState, "unlocked");
  const n = s.audit.head()?.seq;
  assert.deepEqual(s.journal.recover(LOCK).locksCleared, []);
  assert.equal(s.audit.head()?.seq, n, "a second recovery writes nothing");
  s.journal.lockWorkspace(s.id, "daemon");
  assert.equal(s.journal.unlockWorkspace(s.id, "daemon").lockState, "unlocked");
  assert.equal(s.journal.unlockWorkspace(s.id, "daemon").lockState, "unlocked", "unlocking twice is fine");
  s.journal.transitionWorkspace(s.id, "REMOVING");
  s.journal.transitionWorkspace(s.id, "REMOVED");
  assert.throws(() => s.journal.lockWorkspace(s.id, "daemon"), code("E_CONFLICT"));
});

test("only the user's principal still completes a run; the new states do not widen that", () => {
  const s = setup();
  ready(s);
  const run = s.journal.createRun({ workspaceId: s.id, kind: "cli", createdBy: "user" }).value.id;
  s.journal.transitionRun(run, "RUNNING");
  s.journal.transitionRun(run, "REVIEWING");
  assert.throws(() => s.journal.transitionRun(run, "COMPLETED", { actor: "user" }), code("E_POLICY_DENIED"));
  assert.equal(s.journal.transitionRun(run, "COMPLETED", { actor: userPrincipal() }).state, "COMPLETED");
  assert.equal(s.journal.transitionWorkspace(s.id, "FINALISED", { outcome: "merged" }).state, "FINALISED");
});
