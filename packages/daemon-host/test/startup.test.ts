// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { withTransaction } from "@axis/audit";
import { contracts } from "@axis/protocol";
import { AxisError, openDatabase } from "@axis/audit";
import { createDaemonHost, DegradedStartError, exitCodeForStartupError, EXIT, type DaemonHost, type HostServices } from "../src/index.js";
import { hostFixture, type HostFixture } from "../testing/host-fixture.js";
import { processSnapshot, wait, must } from "./helpers.js";

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
    assert.equal(must(s.unsafe).lock.held, true);
    assert.ok(existsSync(join(fix.dataDir, "axis.lock")));
    assert.ok(existsSync(join(fix.dataDir, "axis.db")));
    assert.equal(must(s.audit).verify().ok, true);
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
    assert.throws(() => must(s.unsafe).db.prepare("SELECT 1").get());
    assert.equal(must(s.unsafe).lock.held, false);
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

test("a failure after the lock (git not found) is exit 70 and leaves no lock, handle or timer behind", async () => {
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
  assert.deepEqual(processSnapshot(), before);
});

test("a refused data directory is exit 78", async () => {
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
    const append = (n: number): void => void must(s.audit).append({ actor: "daemon", action: "policy.decision", target: `t:${n}`, outcome: "success", payload: { tier: 0 } });
    assert.throws(() =>
      withTransaction(must(s.unsafe).db, () => {
        must(s.journal).createWorkspace({ projectId: "p1", branch: "axis/x", baseRef: "main", baseSha: "a".repeat(40), createdBy: "user" });
        append(1);
        throw new Error("boom");
      }),
    );
    assert.equal(must(s.audit).head(), null, "the rolled-back event left no trace");
    assert.equal(must(s.journal).listWorkspaces().length, 0);
    withTransaction(must(s.unsafe).db, () => {
      append(2);
      append(3);
    });
    assert.equal(must(s.audit).head()?.seq, 2, "sequence numbers stay contiguous after a rollback");
    assert.equal(must(s.audit).verify().ok, true);
  });
});

test("exit codes follow the step: a conflict raised after the lock is internal (70), not 'another daemon' (75)", async () => {
  const fix = hostFixture({
    ports: {
      registeredRepoRoots: () => {
        throw new AxisError("E_CONFLICT", "illegal transition in a damaged journal");
      },
    },
  });
  const host = createDaemonHost(fix.config, fix.ports);
  try {
    const error = await host.start().then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(error !== undefined);
    assert.equal(exitCodeForStartupError(error), EXIT.INTERNAL);
    assert.deepEqual((error as AxisError).detail, { reason: "startup_step", cause: "E_CONFLICT", causeReason: "none" }, "the original code is kept");
    assert.ok(!existsSync(join(fix.dataDir, "axis.lock")));
  } finally {
    fix.cleanup();
  }
});

test("a path that is not normalised is a configuration error (78) refused before the lock is taken", () => {
  const fix = hostFixture();
  try {
    for (const bad of [`${fix.dataDir}/`, `${fix.root}/x/../data`]) {
      let error: unknown;
      try {
        hostFixture({ root: fix.root, config: { dataDir: bad } });
      } catch (e) {
        error = e;
      }
      assert.equal((error as { code?: string }).code, "E_INVALID_ARGUMENT", bad);
      assert.equal(exitCodeForStartupError(error), EXIT.BAD_CONFIG);
    }
    assert.ok(!existsSync(join(fix.dataDir, "axis.lock")));
  } finally {
    fix.cleanup();
  }
});

test("a stop requested while starting maps to a clean exit (0), not an internal error", () => {
  assert.equal(exitCodeForStartupError(new AxisError("E_CANCELLED", "x")), EXIT.OK);
});

test("a database that the held lock does not guard is refused, and the lock is released", async () => {
  const fix = hostFixture();
  const other = join(fix.root, "other");
  mkdirSync(other, { mode: 0o700 });
  const real = fix.ports.storage;
  const host = createDaemonHost(fix.config, {
    ...fix.ports,
    storage: { acquire: async (path) => ({ ...(await real.acquire(path)), openDatabase: () => openDatabase(join(other, "axis.db")) }) },
  });
  try {
    await assert.rejects(host.start(), (e: AxisError) => e.code === "E_INTERNAL" && e.detail["reason"] === "lock_database");
    assert.ok(!existsSync(join(fix.dataDir, "axis.lock")));
  } finally {
    fix.cleanup();
  }
});

test("stop() during start(): no ready, no anchor.put, start rejects E_CANCELLED, nothing is held; start after stop is refused", async () => {
  let entered!: () => void;
  const reached = new Promise<void>((r) => (entered = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const fix = hostFixture({
    ports: {
      reconcile: async () => {
        entered();
        await gate;
        return { needsAttention: [{ workspaceId: "ws-1", reason: "missing_worktree" as const }] };
      },
    },
  });
  const host = createDaemonHost(fix.config, fix.ports);
  try {
    const started = host.start();
    const outcome = started.then(() => "resolved", (e: { code?: string }) => e.code);
    await reached;
    const stopped = host.stop();
    release();
    assert.equal(await outcome, "E_CANCELLED");
    await stopped;
    await wait(5);
    assert.equal(fix.sent.filter((m) => m["type"] === "ready").length, 0);
    assert.deepEqual(fix.supervisor.puts, []);
    assert.ok(!existsSync(join(fix.dataDir, "axis.lock")));
    await assert.rejects(host.start(), { code: "E_CANCELLED" });
    assert.ok(!existsSync(join(fix.dataDir, "axis.lock")), "a start after stop never takes the lock");
  } finally {
    fix.cleanup();
  }
});
