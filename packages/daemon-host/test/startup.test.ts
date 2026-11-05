// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { withTransaction } from "@axis/audit";
import { contracts } from "@axis/protocol";
import { createDaemonHost, DegradedStartError, exitCodeForStartupError, EXIT, type DaemonHost, type HostServices } from "../src/index.js";
import { hostFixture, type HostFixture } from "../testing/host-fixture.js";
import { processSnapshot, wait } from "./helpers.js";

const idsOf = (): string[] => [...new Set(Object.keys(contracts).map((k) => k.slice(0, k.indexOf("/"))))].sort();
const ready = (f: HostFixture): Array<Record<string, unknown>> => f.sent.filter((m) => m["type"] === "ready");

/** Run `body` on a started host, then stop it and remove everything. */
async function started(
  fix: HostFixture,
  body: (host: DaemonHost, services: HostServices) => Promise<void> | void,
  options?: Parameters<typeof createDaemonHost>[2],
): Promise<void> {
  const host = createDaemonHost(fix.config, fix.ports, options);
  try {
    const services = await host.start();
    await wait(5);
    await body(host, services);
  } finally {
    await host.stop();
    fix.cleanup();
  }
}

test("a first start sends ready with every contract, not degraded, and holds the lock until stop", async () => {
  const before = processSnapshot();
  const fix = hostFixture();
  await started(fix, async (host, s) => {
    assert.equal(host.state, "ready");
    assert.equal(ready(fix).length, 1);
    assert.deepEqual([...(ready(fix)[0]?.["contracts"] as string[])].sort(), idsOf());
    assert.equal(ready(fix)[0]?.["degraded"], undefined);
    assert.equal(s.degraded, undefined);
    assert.ok(s.idempotency !== undefined);
    assert.equal(s.lock.held, true);
    assert.ok(existsSync(join(fix.dataDir, "axis.lock")));
    assert.ok(existsSync(join(fix.dataDir, "axis.db")));
    assert.equal(s.audit.verify().ok, true);
    assert.deepEqual(fix.supervisor.puts, [], "an empty chain has nothing to anchor");
  });
  assert.ok(!existsSync(fix.dataDir) || !existsSync(join(fix.dataDir, "axis.lock")));
  await wait(5);
  assert.deepEqual(processSnapshot(), before, "no timer or process listener left");
});

test("stop closes the database handle, releases the lock and is idempotent; start cannot run twice", async () => {
  const fix = hostFixture();
  const host = createDaemonHost(fix.config, fix.ports);
  try {
    const s = await host.start();
    await assert.rejects(host.start(), { code: "E_INTERNAL" });
    const first = await host.stop();
    assert.equal(first.failures.length, 0);
    assert.equal(host.state, "stopped");
    assert.throws(() => s.db.prepare("SELECT 1").get());
    assert.equal(s.lock.held, false);
    assert.ok(!existsSync(join(fix.dataDir, "axis.lock")));
    assert.equal((await host.stop()).disposed, first.disposed);
  } finally {
    fix.cleanup();
  }
});

test("a second host on the same data directory fails with E_CONFLICT (exit 75) and leaves the first one's lock alone", async () => {
  const fix = hostFixture();
  const second = hostFixture({ root: fix.root });
  const a = createDaemonHost(fix.config, fix.ports);
  const b = createDaemonHost(second.config, second.ports);
  try {
    await a.start();
    const error = await b.start().then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.equal((error as { code?: string }).code, "E_CONFLICT");
    assert.equal(exitCodeForStartupError(error), EXIT.LOCK_HELD);
    assert.equal(b.state, "stopped");
    await wait(5);
    assert.equal(second.sent.filter((m) => m["type"] === "ready").length, 0, "the loser never sends ready");
    assert.ok(existsSync(join(fix.dataDir, "axis.lock")), "the loser did not release the winner's lock");
    await b.stop();
    assert.ok(existsSync(join(fix.dataDir, "axis.lock")));
  } finally {
    await a.stop();
    second.cleanup();
    fix.cleanup();
  }
});

test("a refused data directory is exit 78; a failure after the lock leaves no lock, handle or timer behind", async () => {
  const before = processSnapshot();
  const bad = hostFixture({ env: { PATH: "" } });
  const host = createDaemonHost(bad.config, bad.ports);
  try {
    const error = await host.start().then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.equal((error as { code?: string }).code, "E_UNAVAILABLE");
    assert.equal(exitCodeForStartupError(error), EXIT.INTERNAL);
    assert.ok(!existsSync(join(bad.dataDir, "axis.lock")), "git was not found after the lock was taken: it was released");
    await wait(5);
    assert.equal(bad.sent.filter((m) => m["type"] === "ready").length, 0);
  } finally {
    bad.cleanup();
  }
  const refused = hostFixture();
  writeFileSync(refused.dataDir, "not a directory");
  const h2 = createDaemonHost(refused.config, refused.ports);
  try {
    const e = await h2.start().then(
      () => undefined,
      (x: unknown) => x,
    );
    assert.ok(e !== undefined);
    assert.equal(exitCodeForStartupError(e), EXIT.BAD_CONFIG);
  } finally {
    refused.cleanup();
  }
  assert.deepEqual(processSnapshot(), before);
});

test("exit codes: degraded is 79, conflict 75, bad config 78, anything else 70", () => {
  assert.equal(exitCodeForStartupError(new DegradedStartError("anchor_missing")), 79);
  assert.equal(exitCodeForStartupError(new Error("x")), 70);
  assert.equal(exitCodeForStartupError("x"), 70);
});

test("the policy and the coverage check use the SAME surface: a host serving a subset starts, and denies the rest", async () => {
  const fix = hostFixture({ config: { contracts: ["axis.audit", "axis.projects"] } });
  await started(fix, (_host, s) => {
    assert.deepEqual([...(ready(fix)[0]?.["contracts"] as string[])].sort(), ["axis.audit", "axis.projects"]);
    assert.deepEqual(Object.keys(s.surface.rules).sort(), Object.keys(s.surface.rules).filter((k) => /^axis\.(audit|projects)\//.test(k)).sort());
    const base = { identity: { actor: "user", windowId: "w1", connectionId: "c".repeat(22), trusted: true, clientKind: "test" }, version: 1, tier: 0 };
    const allow = s.policy.evaluate({ ...base, contract: "axis.projects", method: "list" } as never);
    assert.equal(allow.effect, "allow");
    const deny = s.policy.evaluate({ ...base, contract: "axis.worktrees", method: "list" } as never);
    assert.equal(deny.effect, "deny", "a contract outside config.contracts has no policy row");
  });
});

test("the audit sink inside a journal transaction commits or rolls back with it (design 5.3, confirmed)", async () => {
  const fix = hostFixture();
  await started(fix, (_host, s) => {
    const append = (n: number): void => void s.audit.append({ actor: "daemon", action: "policy.decision", target: `t:${n}`, outcome: "success", payload: { tier: 0 } });
    assert.throws(() =>
      withTransaction(s.db, () => {
        s.journal.createWorkspace({ projectId: "p1", branch: "axis/x", baseRef: "main", baseSha: "a".repeat(40), createdBy: "user" });
        append(1);
        throw new Error("boom");
      }),
    );
    assert.equal(s.audit.head(), null, "the rolled-back event left no trace");
    assert.equal(s.journal.listWorkspaces().length, 0);
    withTransaction(s.db, () => {
      append(2);
      append(3);
    });
    assert.equal(s.audit.head()?.seq, 2, "sequence numbers stay contiguous after a rollback");
    assert.equal(s.audit.verify().ok, true);
  });
});
