// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { acquireInstanceLock, AuditLog, openDatabase, Redactor } from "@axis/audit";
import { Journal, JournalIdempotencyStore, RESTART_REASON } from "@axis/journal";
import { createDaemonHost, DEFAULT_RECONCILE_BUDGET_MS } from "../src/index.js";
import { hostFixture, type HostFixture } from "../testing/host-fixture.js";
import { must, trackTimers, wait } from "./helpers.js";

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
function leaveKilledHost(fix: HostFixture, withEvent = false): { runId: string; creatingId: string } {
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
  if (withEvent) audit.append({ actor: "daemon", action: "policy.decision", target: "t:1", outcome: "success", payload: { tier: 0 } });
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
    const run = must(s.journal).getRun(runId);
    assert.equal(run?.state, "BLOCKED");
    const last = must(s.journal).transitions("run", runId).at(-1);
    assert.equal(last?.reason, RESTART_REASON);
    assert.deepEqual(s.idempotency?.begin(KEY, "hash-1"), { state: "unknown", reason: "interrupted" }, "never re-run");
    assert.equal(must(s.journal).getWorkspace(creatingId)?.state, "FAILED");
    // The recovery events are in the chain and the host asked the supervisor to store the new head.
    const head = must(s.audit).head();
    assert.ok(head !== null && head.seq > 0);
    assert.deepEqual(fix.supervisor.puts, [head]);
    assert.deepEqual(s.anchor().put, head);
    assert.equal(s.anchor().ackedSeq, head.seq, "the supervisor's ack is tracked");
    assert.equal(must(s.audit).verify({ expectedHead: head }).ok, true, "the next start's anchor check is ok");
  } finally {
    await host.stop();
    fix.cleanup();
  }
});

test("the anchor.ack listener is removed on stop", async () => {
  const fix = hostFixture();
  const host = createDaemonHost(fix.config, fix.ports);
  try {
    leaveKilledHost(fix);
    const s = await host.start();
    await wait(5);
    const acked = s.anchor().ackedSeq;
    assert.ok(acked > 0);
    await host.stop();
    fix.peer.send({ type: "anchor.ack", seq: acked + 1000 });
    await wait(5);
    assert.equal(s.anchor().ackedSeq, acked, "an ack after stop changes nothing");
  } finally {
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
    const head1 = must(s1.audit).head();
    await first.stop();
    fix.supervisor.anchor = head1;
    const putsAfterFirst = fix.supervisor.puts.length;
    const second = createDaemonHost(fix.config, fix.ports);
    const s2 = await second.start();
    await wait(5);
    assert.equal(fix.supervisor.puts.length, putsAfterFirst, "nothing new to anchor: no anchor.put (not even a repeat)");
    assert.deepEqual(must(s2.audit).head(), head1, "a converged recovery writes nothing");
    assert.equal(s2.degraded, undefined);
    await second.stop();
  } finally {
    fix.cleanup();
  }
});

test("reconcile: the report is kept; a timeout and a failure are audited, never abort startup and carry no error text", async () => {
  const report = { needsAttention: [{ workspaceId: "ws-1", reason: "missing_worktree" as const }] };
  const ok = hostFixture({ ports: { reconcile: () => Promise.resolve(report) } });
  let slowSignal: AbortSignal | undefined;
  const slow = hostFixture({
    config: { limits: { reconcileBudgetMs: 1_000 } },
    ports: {
      reconcile: (signal) => {
        slowSignal = signal;
        return new Promise((_r, reject) => signal.addEventListener("abort", () => reject(new Error("secret-path /x"))));
      },
    },
  });
  const bad = hostFixture({ ports: { reconcile: () => Promise.reject(new Error("SECRET-DETAIL")) } });
  for (const [fix, status, outcome] of [[ok, "ok", "success"], [slow, "timeout", "failure"], [bad, "failed", "failure"]] as const) {
    const host = createDaemonHost(fix.config, fix.ports);
    try {
      const s = await host.start();
      assert.equal(s.recovery?.reconcile, status);
      assert.deepEqual(s.recovery?.needsAttention, status === "ok" ? report.needsAttention : []);
      const events = must(s.audit).list();
      const event = events.find((e) => e.target === "worktrees:reconcile");
      assert.equal(event?.outcome, outcome);
      assert.ok(!JSON.stringify(events).includes("SECRET") && !JSON.stringify(events).includes("secret-path"));
    } finally {
      await host.stop();
      fix.cleanup();
    }
  }
  assert.equal(slowSignal?.aborted, true, "the port is told to stop when the budget runs out");
  assert.equal(DEFAULT_RECONCILE_BUDGET_MS, 20_000);
});

test("a clean reconcile with nothing to report writes no event", async () => {
  const fix = hostFixture({ ports: { reconcile: () => Promise.resolve({ needsAttention: [] }) } });
  const host = createDaemonHost(fix.config, fix.ports);
  try {
    const s = await host.start();
    assert.equal(s.recovery?.reconcile, "ok");
    assert.equal(must(s.audit).head(), null);
  } finally {
    await host.stop();
    fix.cleanup();
  }
});

test("a reconcile report is capped at 1024 entries and leaves no timer behind", async () => {
  const entries = Array.from({ length: 2_000 }, (_v, i) => ({ workspaceId: `ws-${i}`, reason: "unknown_worktree" as const }));
  const fix = hostFixture({ ports: { reconcile: () => Promise.resolve({ needsAttention: entries }) } });
  const timers = trackTimers();
  const host = createDaemonHost(fix.config, fix.ports);
  try {
    const s = await host.start();
    assert.equal(s.recovery?.needsAttention.length, 1_024);
    assert.equal(timers.live(), 0, "the reconcile budget timer was cleared");
  } finally {
    timers.restore();
    await host.stop();
    fix.cleanup();
  }
});

test("stop() during anchor.get cancels the wait at once and runs no recovery write", async () => {
  const fix = hostFixture();
  try {
    const { runId } = leaveKilledHost(fix);
    fix.supervisor.answerDelayMs = 3_000;
    const host = createDaemonHost(fix.config, fix.ports);
    const started = host.start().then(() => "resolved", (e: { code?: string }) => e.code);
    await wait(30); // the anchor.get is in flight
    const t0 = Date.now();
    await host.stop();
    assert.ok(Date.now() - t0 < 1_000, "stop did not wait out the 5 s anchor timeout");
    assert.equal(await started, "E_CANCELLED");
    const db = new DatabaseSync(`${fix.dataDir}/axis.db`);
    try {
      const run = db.prepare("SELECT state FROM agent_runs WHERE id = ?").get(runId) as { state: string };
      assert.equal(run.state, "RUNNING", "recovery never ran");
      assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'journal.recovery'").get() as { n: number }).n), 0);
    } finally {
      db.close();
    }
    assert.equal(fix.sent.filter((m) => m["type"] === "ready").length, 0);
  } finally {
    fix.cleanup();
  }
});

test("stop() during a reconcile that ignores its signal does not wait out the budget and writes no event", async () => {
  const fix = hostFixture({ ports: { reconcile: () => new Promise(() => undefined) } });
  const host = createDaemonHost(fix.config, fix.ports);
  try {
    const started = host.start().then(() => "resolved", (e: { code?: string }) => e.code);
    await wait(50);
    const t0 = Date.now();
    await host.stop();
    assert.ok(Date.now() - t0 < 1_000);
    assert.equal(await started, "E_CANCELLED");
  } finally {
    fix.cleanup();
  }
});

test("stop() right after the anchor answer arrives (a sound chain) still runs no recovery write", async () => {
  const fix = hostFixture();
  try {
    const { runId } = leaveKilledHost(fix, true);
    const peek = new DatabaseSync(`${fix.dataDir}/axis.db`);
    const row = peek.prepare("SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1").get() as { seq: number; hash: string };
    peek.close();
    fix.supervisor.anchor = { seq: Number(row.seq), hash: row.hash };
    const holder: { host?: ReturnType<typeof createDaemonHost> } = {};
    const control = {
      send: (m: Parameters<typeof fix.client.send>[0]) => fix.client.send(m),
      anchorPut: (h: Parameters<typeof fix.client.anchorPut>[0]) => fix.client.anchorPut(h),
      onAnchorAck: (h: Parameters<typeof fix.client.onAnchorAck>[0]) => fix.client.onAnchorAck(h),
      anchorGet: async (o?: Parameters<typeof fix.client.anchorGet>[0]) => {
        const answer = await fix.client.anchorGet(o);
        void holder.host?.stop(); // the stop lands between the answer and the check that follows it
        return answer;
      },
    };
    const host = (holder.host = createDaemonHost(fix.config, { ...fix.ports, control }));
    assert.equal(await host.start().then(() => "resolved", (e: { code?: string }) => e.code), "E_CANCELLED");
    await host.stop();
    const db = new DatabaseSync(`${fix.dataDir}/axis.db`);
    try {
      assert.equal((db.prepare("SELECT state FROM agent_runs WHERE id = ?").get(runId) as { state: string }).state, "RUNNING");
    } finally {
      db.close();
    }
    assert.equal(fix.sent.filter((m) => m["type"] === "ready").length, 0);
  } finally {
    fix.cleanup();
  }
});
