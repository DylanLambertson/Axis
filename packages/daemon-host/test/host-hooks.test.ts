// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AxisError } from "@axis/audit";
import { createDaemonHost, type HostServices, type StorageParts } from "../src/index.js";
import { hostFixture } from "../testing/host-fixture.js";

const sentTypes = (f: ReturnType<typeof hostFixture>): string[] => f.sent.map((m) => String(m["type"]));

test("afterStorage runs before recovery (reconcile), beforeReady before ready; both see the writable stores", async () => {
  const fix = hostFixture();
  const order: string[] = [];
  let parts: StorageParts | undefined;
  const host = createDaemonHost(fix.config, {
    ...fix.ports,
    afterStorage: (p) => (order.push("afterStorage"), void (parts = p)),
    reconcile: async () => (order.push("reconcile"), { needsAttention: [] }),
    beforeReady: (s: HostServices, lock) => {
      order.push(`beforeReady:${sentTypes(fix).includes("ready")}:${lock !== undefined}`);
    },
  });
  try {
    await host.start();
    assert.deepEqual(order, ["afterStorage", "reconcile", "beforeReady:false:true"], "ready was not sent yet when the composition ran");
    assert.ok(sentTypes(fix).includes("ready"));
    assert.ok(parts?.journal !== undefined && parts.audit !== undefined && parts.idempotency !== undefined && parts.db !== undefined);
  } finally {
    await host.stop();
    fix.cleanup();
  }
});

test("a beforeReady that throws sends no ready, and holds nothing: the lock is free again", async () => {
  const fix = hostFixture();
  try {
    const failing = createDaemonHost(fix.config, { ...fix.ports, beforeReady: () => { throw new AxisError("E_INTERNAL", "composition failed"); } });
    await assert.rejects(failing.start(), { code: "E_INTERNAL" });
    assert.ok(!sentTypes(fix).includes("ready"), "nothing was served");
    assert.equal(failing.state, "stopped");
    const again = createDaemonHost(fix.config, fix.ports);
    await again.start(); // the data directory lock was released by the failed start
    await again.stop();
  } finally {
    fix.cleanup();
  }
});

test("a degraded host skips afterStorage (nothing may write) but still runs beforeReady with no lock", async () => {
  const fix = hostFixture();
  fix.supervisor.answerAnchorGet = false; // no answer is never read as "no anchor": degraded `anchor_unreachable`
  let after = 0;
  let lockSeen: unknown = "unset";
  const host = createDaemonHost(fix.config, {
    ...fix.ports,
    afterStorage: () => void after++,
    beforeReady: (s, lock) => void (lockSeen = [s.degraded, lock]),
  }, { anchorTimeoutMs: 50 });
  try {
    const s = await host.start();
    assert.equal(after, 0);
    assert.deepEqual(lockSeen, ["anchor_unreachable", undefined]);
    assert.equal(s.journal, undefined);
  } finally {
    await host.stop();
    fix.cleanup();
  }
});
