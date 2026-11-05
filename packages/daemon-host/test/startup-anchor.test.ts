// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createDaemonHost, DegradedStartError, exitCodeForStartupError, EXIT, type DegradedReason, type HostServices } from "../src/index.js";
import { hostFixture, type HostFixture } from "../testing/host-fixture.js";
import { wait, must } from "./helpers.js";

/** Start a host, write `n` audit events, stop it. Returns the head the supervisor would hold. */
async function seed(fix: HostFixture, n: number): Promise<{ seq: number; hash: string }> {
  const host = createDaemonHost(fix.config, fix.ports);
  const s = await host.start();
  for (let i = 1; i <= n; i++) must(s.audit).append({ actor: "daemon", action: "policy.decision", target: `t:${i}`, outcome: "success", payload: { tier: 0 } });
  const head = must(s.audit).head();
  await host.stop();
  assert.ok(head !== null);
  fix.sent.length = 0;
  return head;
}

/** Edit the stored chain the way an attacker with file access could: drop the append-only triggers first. */
function tamper(fix: HostFixture, sql: string): void {
  const db = new DatabaseSync(join(fix.dataDir, "axis.db"));
  try {
    db.exec("DROP TRIGGER IF EXISTS audit_events_no_update; DROP TRIGGER IF EXISTS audit_events_no_delete;");
    db.exec(sql);
  } finally {
    db.close();
  }
}

async function startAgain(fix: HostFixture, options?: Parameters<typeof createDaemonHost>[2]) {
  const host = createDaemonHost(fix.config, fix.ports, options);
  const services = await host.start();
  await wait(5);
  return { host, services, ready: fix.sent.find((m) => m["type"] === "ready") };
}

const ident = { actor: "user", windowId: "w1", connectionId: "c".repeat(22), trusted: true, clientKind: "test" };
const decide = (s: HostServices, contract: string, method: string): string =>
  s.policy.evaluate({ identity: { ...ident, workspaceId: "ws" }, contract, version: 1, method, tier: 0 } as never).effect;

/** Degraded is enforced by construction: nothing writable, and the policy denies every non-degraded method. */
function assertDegradedServices(s: HostServices): void {
  assert.equal(s.audit, undefined);
  assert.equal(s.journal, undefined);
  assert.equal(s.unsafe, undefined);
  assert.deepEqual(Object.keys(s.surface.rules).sort(), ["axis.audit/1.list", "axis.audit/1.status", "axis.audit/1.verify", "axis.projects/1.list"]);
  for (const [c, m] of [["axis.audit", "status"], ["axis.audit", "list"], ["axis.audit", "verify"], ["axis.projects", "list"]] as const) {
    assert.equal(decide(s, c, m), "allow", `${c}.${m}`);
  }
  for (const [c, m] of [["axis.worktrees", "finalise"], ["axis.worktrees", "list"], ["axis.approvals", "resolve"], ["axis.cli-runs", "start"], ["axis.providers", "list"]] as const) {
    assert.equal(decide(s, c, m), "deny", `${c}.${m} must be denied when degraded`);
  }
}

const REASONS = [
  ["the chain is shorter than the anchor", "DELETE FROM audit_events WHERE seq > 2", "database_behind_anchor"],
  ["the database was emptied", "DELETE FROM audit_events", "database_behind_anchor"],
  ["an event before the anchor was edited", "UPDATE audit_events SET target = 'x:edited' WHERE seq = 1", "audit_chain_invalid"],
  ["an event was removed from the middle", "DELETE FROM audit_events WHERE seq = 2", "audit_chain_invalid"],
  ["the audit table cannot be read", "DROP TABLE audit_events", "audit_unreadable"],
] as const satisfies ReadonlyArray<readonly [string, string, DegradedReason]>;

for (const [name, sql, reason] of REASONS) {
  test(`degraded (${reason}): ${name}; only audit and projects are served and the chain is not extended`, async () => {
    const fix = hostFixture();
    try {
      fix.supervisor.anchor = await seed(fix, 4);
      tamper(fix, sql);
      const before = new DatabaseSync(join(fix.dataDir, "axis.db"));
      const count = (): number => (reason === "audit_unreadable" ? 0 : Number((before.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n));
      const eventsBefore = count();
      before.close();
      const { host, services, ready } = await startAgain(fix);
      try {
        assert.equal(services.degraded, reason);
        assert.equal(ready?.["degraded"], reason);
        assert.deepEqual([...(ready?.["contracts"] as string[])].sort(), ["axis.audit", "axis.projects"]);
        assert.equal(services.idempotency, undefined, "no store is opened on a chain that cannot be trusted");
        assert.equal(services.recovery, undefined, "recovery writes, so it does not run");
        assert.equal(fix.supervisor.puts.length, 0, "a degraded host never re-anchors on its own");
        if (reason !== "audit_unreadable") assert.equal(services.auditRead.list({ limit: 1000 }).length, eventsBefore, "the host appended nothing");
        assertDegradedServices(services);
      } finally {
        await host.stop();
      }
    } finally {
      fix.cleanup();
    }
  });
}

test("degraded anchor_mismatch: the event at the anchor's sequence has another hash", async () => {
  const fix = hostFixture();
  try {
    const head = await seed(fix, 3);
    fix.supervisor.anchor = { seq: head.seq, hash: "f".repeat(64) };
    const { host, services } = await startAgain(fix);
    assert.equal(services.degraded, "anchor_mismatch");
    await host.stop();
  } finally {
    fix.cleanup();
  }
});

test("degraded anchor_missing: events exist and the supervisor holds no anchor", async () => {
  const fix = hostFixture();
  try {
    await seed(fix, 2);
    fix.supervisor.anchor = null;
    const { host, services } = await startAgain(fix);
    assert.equal(services.degraded, "anchor_missing");
    await host.stop();
  } finally {
    fix.cleanup();
  }
});

test("degraded anchor_unreachable: the supervisor does not answer in time", async () => {
  const fix = hostFixture();
  try {
    await seed(fix, 2);
    fix.supervisor.answerAnchorGet = false;
    const { host, services } = await startAgain(fix, { anchorTimeoutMs: 40 });
    assert.equal(services.degraded, "anchor_unreachable");
    await host.stop();
  } finally {
    fix.cleanup();
  }
});

test("a first start needs an EXPLICIT 'no anchor' answer; no answer is anchor_unreachable even on an empty chain", async () => {
  const fix = hostFixture();
  try {
    const { host, services } = await startAgain(fix);
    assert.equal(services.degraded, undefined, "the supervisor answered: no anchor");
    await host.stop();
  } finally {
    fix.cleanup();
  }
  const silent = hostFixture();
  try {
    silent.supervisor.answerAnchorGet = false;
    const { host, services } = await startAgain(silent, { anchorTimeoutMs: 40 });
    assert.equal(services.degraded, "anchor_unreachable");
    assert.equal(services.idempotency, undefined);
    assert.equal(services.recovery, undefined);
    assert.deepEqual(silent.supervisor.puts, []);
    assertDegradedServices(services);
    await host.stop();
  } finally {
    silent.cleanup();
  }
});

test("deleting axis.db with a supervisor that answers late: degraded, no anchor.put, the stored anchor is not replaced", async () => {
  const fix = hostFixture();
  try {
    const head = await seed(fix, 5);
    fix.supervisor.anchor = head;
    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(fix.dataDir, `axis.db${suffix}`), { force: true });
    fix.supervisor.answerDelayMs = 150;
    const { host, services } = await startAgain(fix, { anchorTimeoutMs: 40 });
    await wait(250); // the late, non-null answer arrives after the timeout
    assert.equal(services.degraded, "anchor_unreachable");
    assert.deepEqual(fix.supervisor.puts, [], "no anchor.put was sent");
    assert.deepEqual(fix.supervisor.anchor, head, "the supervisor's anchor is untouched");
    assert.ok(fix.client.stats().ignoredAnswers >= 1, "the late answer was ignored, not acted on");
    assert.equal(fix.sent.find((m) => m["type"] === "ready")?.["degraded"], "anchor_unreachable");
    await host.stop();
  } finally {
    fix.cleanup();
  }
});

test("a sound chain with the matching anchor starts normally and serves everything", async () => {
  const fix = hostFixture();
  try {
    fix.supervisor.anchor = await seed(fix, 3);
    const { host, services, ready } = await startAgain(fix);
    assert.equal(services.degraded, undefined);
    assert.equal(ready?.["degraded"], undefined);
    assert.ok(services.idempotency !== undefined);
    assert.equal(services.anchor().atStart?.seq, 3);
    await host.stop();
  } finally {
    fix.cleanup();
  }
});

test("exitOnDegraded: start rejects with exit code 79, sends no ready and releases the lock", async () => {
  const fix = hostFixture();
  try {
    await seed(fix, 2);
    fix.supervisor.anchor = null;
    const host = createDaemonHost(fix.config, fix.ports, { exitOnDegraded: true });
    const error = await host.start().then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(error instanceof DegradedStartError);
    assert.equal(error.reason, "anchor_missing");
    assert.equal(exitCodeForStartupError(error), EXIT.DEGRADED);
    await wait(5);
    assert.equal(fix.sent.filter((m) => m["type"] === "ready").length, 0);
    assert.ok(!existsSync(join(fix.dataDir, "axis.lock")));
  } finally {
    fix.cleanup();
  }
});
