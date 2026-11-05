// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { acquireInstanceLock, AuditLog, openDatabase, Redactor } from "@axis/audit";
import { Journal, JournalIdempotencyStore, RESTART_REASON } from "@axis/journal";
import { createDaemonHost, DEFAULT_RECONCILE_BUDGET_MS } from "../src/index.js";
import { hostFixture, type HostFixture } from "../testing/host-fixture.js";
import { wait } from "./helpers.js";

/** A pid that is not running: a child that has already exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(r.pid !== undefined && r.pid > 0);
  return r.pid;
}

const KEY = { actorId: "user", workspaceId: "ws-seed", contract: "axis.worktrees", version: 1, method: "create", key: "k-seed-1" } as const;

/**
 * What a host that was killed leaves behind: a lock whose pid is dead, a RUNNING run, a CREATING workspace and an
 * idempotency key still in progress. Nothing is closed cleanly: the lock is never released.
 */
function leaveKilledHost(fix: HostFixture): { runId: string; creatingId: string } {
  const lock = acquireInstanceLock(fix.dataDir, { pid: deadPid(), procStart: () => undefined });
  const db = openDatabase(`${fix.dataDir}/axis.db`);
  const audit = new AuditLog(db, { redactor: new Redactor() });
  const journal = Journal.open(db, { audit });
  const ws = journal.createWorkspace({ projectId: "p1", branch: "axis/a", baseRef: "main", baseSha: "a".repeat(40), createdBy: "user" }).value;
  journal.transitionWorkspace(ws.id, "READY");
  const run = journal.createRun({ workspaceId: ws.id, kind: "cli", createdBy: "user" }).value;
  journal.transitionRun(run.id, "RUNNING");
  const creating = journal.createWorkspace({ projectId: "p1", branch: "axis/b", baseRef: "main", baseSha: "a".repeat(40), createdBy: "user" }).value;
  const store = JournalIdempotencyStore.open(db, { audit, redactor: new Redactor(), bootId: () => "boot-killed" });
  assert.deepEqual(store.begin(KEY, "hash-1"), { state: "new" });
  db.close();
  assert.equal(lock.held, true, "the killed host never released its lock");
  return { runId: run.id, creatingId: creating.id };
}

test("a killed host: the stale lock is taken over, RUNNING becomes BLOCKED INTERRUPTED_BY_RESTART, the key is unknown, the recovery is anchored", async () => {
  const fix = hostFixture();
  const host = createDaemonHost(fix.config, fix.ports);
  try {
    const { runId, creatingId } = leaveKilledHost(fix);
    const s = await host.start();
    await wait(5);
    assert.deepEqual(s.recovery?.journal.runsInterrupted, [runId]);
    assert.deepEqual(s.recovery?.journal.workspacesFailed, [creatingId]);
    assert.equal(s.recovery?.keysInterrupted, 1);
    const run = s.journal.getRun(runId);
    assert.equal(run?.state, "BLOCKED");
    const last = s.journal.transitions("run", runId).at(-1);
    assert.equal(last?.reason, RESTART_REASON);
    assert.deepEqual(s.idempotency?.begin(KEY, "hash-1"), { state: "unknown", reason: "interrupted" }, "never re-run");
    assert.equal(s.journal.getWorkspace(creatingId)?.state, "FAILED");
    // The recovery events are in the chain and the host asked the supervisor to store the new head.
    const head = s.audit.head();
    assert.ok(head !== null && head.seq > 0);
    assert.deepEqual(fix.supervisor.puts, [head]);
    assert.deepEqual(s.anchor().put, head);
    assert.equal(s.anchor().ackedSeq, head.seq, "the supervisor's ack is tracked");
    assert.equal(s.audit.verify({ expectedHead: head }).ok, true, "the next start's anchor check is ok");
  } finally {
    await host.stop();
    fix.cleanup();
  }
});

test("a live holder is not taken over: the same pid and start time is E_CONFLICT", async () => {
  const fix = hostFixture();
  const lock = acquireInstanceLock(fix.dataDir);
  const host = createDaemonHost(fix.config, fix.ports);
  try {
    await assert.rejects(host.start(), { code: "E_CONFLICT" });
  } finally {
    lock.release();
    fix.cleanup();
  }
});

test("recovery happens only with the held lock: a restart after a completed recovery changes nothing", async () => {
  const fix = hostFixture();
  try {
    leaveKilledHost(fix);
    const first = createDaemonHost(fix.config, fix.ports);
    const s1 = await first.start();
    const head1 = s1.audit.head();
    await first.stop();
    fix.supervisor.anchor = head1;
    const second = createDaemonHost(fix.config, fix.ports);
    const s2 = await second.start();
    assert.deepEqual(s2.audit.head(), head1, "a converged recovery writes nothing");
    assert.equal(s2.degraded, undefined);
    await second.stop();
  } finally {
    fix.cleanup();
  }
});

test("reconcile: the report is kept; a timeout and a failure are audited, never abort startup and carry no error text", async () => {
  const report = { needsAttention: [{ workspaceId: "ws-1", reason: "missing_worktree" as const }] };
  const ok = hostFixture({ ports: { reconcile: () => Promise.resolve(report) } });
  const slow = hostFixture({
    config: { limits: { reconcileBudgetMs: 1_000 } },
    ports: { reconcile: (signal) => new Promise((_r, reject) => signal.addEventListener("abort", () => reject(new Error("secret-path /x")))) },
  });
  const bad = hostFixture({ ports: { reconcile: () => Promise.reject(new Error("SECRET-DETAIL")) } });
  for (const [fix, status, outcome] of [[ok, "ok", "success"], [slow, "timeout", "failure"], [bad, "failed", "failure"]] as const) {
    const host = createDaemonHost(fix.config, fix.ports);
    try {
      const s = await host.start();
      assert.equal(s.recovery?.reconcile, status);
      assert.deepEqual(s.recovery?.needsAttention, status === "ok" ? report.needsAttention : []);
      const events = s.audit.list();
      const event = events.find((e) => e.target === "worktrees:reconcile");
      assert.equal(event?.outcome, outcome);
      assert.ok(!JSON.stringify(events).includes("SECRET") && !JSON.stringify(events).includes("secret-path"));
    } finally {
      await host.stop();
      fix.cleanup();
    }
  }
  assert.equal(DEFAULT_RECONCILE_BUDGET_MS, 20_000);
});

test("a clean reconcile with nothing to report writes no event", async () => {
  const fix = hostFixture({ ports: { reconcile: () => Promise.resolve({ needsAttention: [] }) } });
  const host = createDaemonHost(fix.config, fix.ports);
  try {
    const s = await host.start();
    assert.equal(s.recovery?.reconcile, "ok");
    assert.equal(s.audit.head(), null);
  } finally {
    await host.stop();
    fix.cleanup();
  }
});
