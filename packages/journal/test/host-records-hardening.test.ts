// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { after, test } from "node:test";
import { AuditLog, AxisError, acquireInstanceLock, openDatabase } from "@axis/audit";
import { userPrincipal } from "../src/daemon-principal.js";
import { Journal } from "../src/index.js";

const SHA = "b".repeat(40);
const USER = userPrincipal();
const code = (c: string) => (e: unknown) => e instanceof AxisError && e.code === c;
const DIR = mkdtempSync(join(tmpdir(), "axis-journal-hardening-"));
const LOCK = acquireInstanceLock(DIR);
after(() => {
  LOCK.release();
  rmSync(DIR, { recursive: true, force: true });
});
const abs = (...p: string[]): string => resolve(DIR, ...p);
const root = resolve(sep);

function setup() {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db);
  const journal = Journal.open(db, { audit });
  const ws = (branch = "axis/x") => journal.createWorkspace({ projectId: "p", branch, baseRef: "main", baseSha: SHA, createdBy: "user" }).value.id;
  return { db, audit, journal, ws };
}
const events = (s: ReturnType<typeof setup>, since: number) => s.audit.list({ afterSeq: since });
const seq = (s: ReturnType<typeof setup>): number => s.audit.head()?.seq ?? 0;

test("S1: recording a reviewed tree needs the minted user principal; a string, an agent, the daemon and a forged object are denied", () => {
  const s = setup();
  const id = s.ws();
  s.journal.transitionWorkspace(id, "READY");
  const n = seq(s);
  for (const actor of ["user", "daemon", "agent:claude-cli", { actor: "user" }, Object.create(Object.getPrototypeOf(USER) as object)]) {
    assert.throws(() => s.journal.recordReviewedTree(id, "e".repeat(40), actor as never), code("E_POLICY_DENIED"));
  }
  assert.equal(s.journal.getWorkspace(id)?.reviewedTreeHash, null);
  assert.equal(seq(s), n);
  assert.equal(s.journal.recordReviewedTree(id, "e".repeat(40), USER).reviewedTreeHash, "e".repeat(40));
  assert.equal(events(s, n)[0]?.actor, "user");
});

test("S2: a trailing separator is the same project as without it, and a root is never a project", () => {
  const s = setup();
  s.journal.registerProject({ id: "a", path: abs("repo"), displayName: "A", trusted: false, actor: "user" });
  assert.throws(() => s.journal.registerProject({ id: "b", path: `${abs("repo")}${sep}`, displayName: "B", trusted: false, actor: "user" }), code("E_CONFLICT"));
  assert.throws(() => s.journal.registerProject({ id: "b", path: `${abs("repo")}${sep}${sep}`, displayName: "B", trusted: false, actor: "user" }), code("E_CONFLICT"));
  assert.equal(s.journal.registerProject({ id: "c", path: `${abs("other")}${sep}`, displayName: "C", trusted: false, actor: "user" }).path, abs("other"), "stored without the separator");
  assert.throws(() => s.journal.registerProject({ id: "r", path: root, displayName: "R", trusted: false, actor: "user" }), code("E_INVALID_ARGUMENT"));
  for (const path of ["rel/x", "", "./x", `${abs("n")}\u0000x`]) {
    assert.throws(() => s.journal.registerProject({ id: "x", path, displayName: "X", trusted: false, actor: "user" }), code("E_INVALID_ARGUMENT"));
  }
  assert.equal(s.journal.listProjects().length, 2);
});

test("S2/N3: the database refuses a trailing separator, a root, a relative path and a NUL on its own, each check alone", () => {
  const { db } = setup();
  const proj = (path: string) => db.prepare("INSERT INTO projects (id, path, display_name, trusted, created_at, updated_at) VALUES (?, ?, 'n', 0, 't', 't')").run(path, path);
  proj("/ok/path");
  for (const bad of ["/", "/ok/", "/ok\\", "rel/x", "/a\u0000b", "x"]) assert.throws(() => proj(bad), /./, JSON.stringify(bad));
  const wt = (path: string) => db.prepare("INSERT INTO agent_workspaces (id, project_id, branch, base_ref, base_sha, created_by, state, created_at, updated_at, worktree_path) VALUES (?, 'p', 'b', 'r', 's', 'user', 'READY', 't', 't', ?)").run(path, path);
  wt("/ok/wt");
  for (const bad of ["/", "/ok/wt2/", "rel/x", "/a\u0000b"]) assert.throws(() => wt(bad), /./, JSON.stringify(bad));
  assert.throws(() => proj(`/${"a".repeat(4096)}`), /./, "over 4096, otherwise a valid path");
  assert.throws(() => wt(`/${"a".repeat(4096)}`));
});

test("S3: two live workspaces cannot share a worktree path; a removed or failed one frees it", () => {
  const s = setup();
  const w1 = s.ws("axis/one");
  const w2 = s.ws("axis/two");
  s.journal.setWorktreePath(w1, abs("wt"), "daemon");
  assert.throws(() => s.journal.setWorktreePath(w2, abs("wt"), "daemon"), code("E_CONFLICT"));
  assert.throws(() => s.journal.setWorktreePath(w2, `${abs("wt")}${sep}`, "daemon"), code("E_CONFLICT"), "the trailing-separator spelling is the same path");
  assert.equal(s.journal.getWorkspace(w2)?.worktreePath, null);
  s.journal.transitionWorkspace(w1, "FAILED");
  assert.equal(s.journal.setWorktreePath(w2, abs("wt"), "daemon").worktreePath, abs("wt"));
});

test("S4: each audited writer appends exactly one event, in the same transaction", () => {
  const s = setup();
  const id = s.ws();
  s.journal.transitionWorkspace(id, "READY");
  const check = (what: string, fn: () => unknown, action: string, target: string) => {
    const n = seq(s);
    fn();
    const e = events(s, n);
    assert.equal(e.length, 1, what);
    assert.equal(e[0]?.action, action, what);
    assert.equal(e[0]?.target, target, what);
  };
  // Same transaction: with the audit insert forced to fail, the change does not survive.
  const failing = (fn: () => unknown, read: () => unknown, before: unknown) => {
    s.db.exec("CREATE TEMP TRIGGER no_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'no'); END");
    assert.throws(fn);
    s.db.exec("DROP TRIGGER no_audit");
    assert.deepEqual(read(), before);
  };
  check("register", () => s.journal.registerProject({ id: "p1", path: abs("p1"), displayName: "P", trusted: true, actor: "user" }), "journal.project.register", "project:p1");
  failing(() => s.journal.registerProject({ id: "p2", path: abs("p2"), displayName: "P", trusted: true, actor: "user" }), () => s.journal.getProject("p2"), undefined);
  check("lock", () => s.journal.lockWorkspace(id, "daemon"), "journal.workspace.lock", `workspace:${id}`);
  failing(() => s.journal.unlockWorkspace(id, "daemon"), () => s.journal.getWorkspace(id)?.lockState, "locked");
  check("unlock", () => s.journal.unlockWorkspace(id, "daemon"), "journal.workspace.unlock", `workspace:${id}`);
  failing(() => s.journal.lockWorkspace(id, "daemon"), () => s.journal.getWorkspace(id)?.lockState, "unlocked");
  check("path", () => s.journal.setWorktreePath(id, abs("w"), "daemon"), "journal.workspace.record", `workspace:${id}`);
  const rec = events(s, seq(s) - 1)[0];
  assert.deepEqual(rec?.payload, { field: "worktreePath" }, "the field name is readable and the value is not stored");
  check("pushed", () => s.journal.recordPushed(id, SHA, "daemon"), "journal.workspace.record", `workspace:${id}`);
  assert.deepEqual(events(s, seq(s) - 1)[0]?.payload, { field: "lastPushedSha" });
  check("tree", () => s.journal.recordReviewedTree(id, "e".repeat(40), USER), "journal.workspace.record", `workspace:${id}`);
  assert.deepEqual(events(s, seq(s) - 1)[0]?.payload, { field: "reviewedTreeHash" });
  assert.equal(s.audit.verify().ok, true);
});

test("S4: recovery audits each cleared lock once, with the workspace left unlocked and updated", () => {
  let tick = 0;
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db);
  const journal = Journal.open(db, { audit, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)) });
  const id = journal.createWorkspace({ projectId: "p", branch: "axis/x", baseRef: "main", baseSha: SHA, createdBy: "user" }).value.id;
  journal.transitionWorkspace(id, "READY");
  const locked = journal.lockWorkspace(id, "daemon");
  const n = audit.head()?.seq ?? 0;
  assert.deepEqual(journal.recover(LOCK).locksCleared, [id]);
  const e = audit.list({ afterSeq: n });
  assert.equal(e.length, 1);
  assert.equal(e[0]?.action, "journal.recovery");
  assert.equal(e[0]?.target, `workspace:${id}`);
  assert.ok((journal.getWorkspace(id)?.updatedAt ?? "") > locked.updatedAt, "updated_at moves");
});

test("recovery of a CREATING workspace that holds a lock reports the lock and ends FAILED and unlocked", () => {
  const s = setup();
  const id = s.ws();
  s.journal.lockWorkspace(id, "daemon");
  const r = s.journal.recover(LOCK);
  assert.deepEqual(r.locksCleared, [id]);
  assert.deepEqual(r.workspacesFailed, [id]);
  assert.equal(s.journal.getWorkspace(id)?.lockState, "unlocked");
});

test("N4: a workspace that is removed or failed holds no lock", () => {
  const s = setup();
  const a = s.ws("axis/a");
  s.journal.transitionWorkspace(a, "READY");
  s.journal.lockWorkspace(a, "daemon");
  s.journal.transitionWorkspace(a, "REMOVING");
  assert.equal(s.journal.getWorkspace(a)?.lockState, "locked", "still held while removing");
  const gone = s.journal.transitionWorkspace(a, "REMOVED");
  assert.deepEqual([gone.lockState, gone.lockedAt], ["unlocked", null]);
  const b = s.ws("axis/b");
  s.journal.lockWorkspace(b, "daemon");
  assert.equal(s.journal.transitionWorkspace(b, "FAILED").lockState, "unlocked");
  assert.throws(() => s.db.prepare("UPDATE agent_workspaces SET lock_state = 'locked', locked_at = 't' WHERE id = ?").run(a), /./, "the database says so too");
});

test("N6: an outcome is refused on a run transition; N7: a CHECK failure is not 'already registered'", () => {
  const s = setup();
  const id = s.ws();
  s.journal.transitionWorkspace(id, "READY");
  const run = s.journal.createRun({ workspaceId: id, kind: "cli", createdBy: "user" }).value.id;
  assert.throws(() => s.journal.transitionRun(run, "RUNNING", { outcome: "merged" }), code("E_INVALID_ARGUMENT"));
  assert.equal(s.journal.getRun(run)?.state, "QUEUED");
  s.db.exec("CREATE TEMP TRIGGER bad BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: fake'); END");
  assert.throws(() => s.journal.registerProject({ id: "z", path: abs("z"), displayName: "Z", trusted: true, actor: "user" }), (e: unknown) => !(e instanceof AxisError && e.code === "E_CONFLICT"));
});

test("N1: a fallback to FINALISED refuses a new outcome and keeps the old one; a 50-character sha is refused; the 4096 bound and the review pair are checked alone", () => {
  const s = setup();
  const id = s.ws();
  s.journal.transitionWorkspace(id, "READY");
  s.journal.transitionWorkspace(id, "FINALISED", { outcome: "merged" });
  s.journal.transitionWorkspace(id, "REMOVING");
  assert.throws(() => s.journal.transitionWorkspace(id, "FINALISED", { outcome: "abandoned" }), code("E_INVALID_ARGUMENT"));
  assert.equal(s.journal.transitionWorkspace(id, "FINALISED").finaliseOutcome, "merged");
  const s2 = setup();
  const w = s2.ws();
  s2.journal.transitionWorkspace(w, "READY");
  assert.throws(() => s2.journal.recordPushed(w, "a".repeat(50), "daemon"), code("E_INVALID_ARGUMENT"));
  assert.throws(() => s2.journal.recordReviewedTree(w, "a".repeat(50), USER), code("E_INVALID_ARGUMENT"));
  assert.throws(() => s2.journal.setWorktreePath(w, `${abs("x")}${sep}${"a".repeat(4100)}`, "daemon"), code("E_INVALID_ARGUMENT"));
  const row = (cols: string, ...args: Array<string | null>) =>
    s2.db.prepare(`INSERT INTO agent_workspaces (id, project_id, branch, base_ref, base_sha, created_by, state, created_at, updated_at, ${cols}) VALUES (?, 'p', 'b', 'r', 's', 'user', 'READY', 't', 't', ?, ?)`).run(`r${Math.random()}`, ...args);
  assert.throws(() => row("reviewed_tree_hash, reviewed_at", "a".repeat(41), "t"), /./, "length check alone: pair is satisfied");
  assert.throws(() => row("reviewed_tree_hash, reviewed_at", "a".repeat(40), null), /./, "pair check alone: hash is well formed");
  assert.throws(() => row("reviewed_tree_hash, reviewed_at", null, "t"), /./, "pair check, other direction");
  row("reviewed_tree_hash, reviewed_at", "a".repeat(40), "t");
});
