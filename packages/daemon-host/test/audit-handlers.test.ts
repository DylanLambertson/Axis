// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Daemon, memoryPair, type ApprovalGate, type Handler, type Identity } from "@axis/daemon";
import { auditListResponseSchema, auditStatusResponseSchema, auditVerifyResponseSchema } from "@axis/protocol";
import { createDaemonHost, createHandlerRegistrar, guardHandlers, registerAuditHandlers, type HostServices } from "../src/index.js";
import { hostFixture, type HostFixture } from "../testing/host-fixture.js";
import { must, wait } from "./helpers.js";

const user: Identity = { connectionId: "conn-1".padEnd(22, "_"), windowId: "win-1", actorId: "actor-1", actor: "user", trusted: true, clientKind: "desktop" };
const CANARY = ["cred", "ential", "-canary-", "value"].join("");

interface Reply {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { code: string; message: string; details?: unknown };
}

/** A real Daemon over `memoryPair`, with the host's own policy, so what the test sees is what a window sees. */
async function serve(services: HostServices, extra?: (d: Daemon, r: ReturnType<typeof createHandlerRegistrar>) => void, approvals?: ApprovalGate) {
  const internal: unknown[] = [];
  const daemon = new Daemon({
    identity: { verify: () => user },
    audit: { append: () => undefined },
    idempotency: new (await import("@axis/daemon")).MemoryIdempotencyStore(),
    policy: services.policy,
    ...(approvals === undefined ? {} : { approvals }),
    onInternalError: (_id, e) => void internal.push(e),
  });
  const registrar = createHandlerRegistrar(daemon, services.anchors);
  registerAuditHandlers(registrar, { audit: services.auditRead, anchors: services.anchors, degraded: () => services.degraded, clock: { monotonic: () => performance.now() } });
  extra?.(daemon, registrar);
  const { client, server } = memoryPair();
  const replies: Array<Record<string, unknown>> = [];
  client.on("message", (m) => void replies.push(m as Record<string, unknown>));
  daemon.accept(server, "attestation");
  client.postMessage({
    type: "hello",
    protocolVersions: [1],
    contracts: [
      { id: "axis.audit", versions: [1] },
      { id: "axis.worktrees", versions: [1] },
    ],
  });
  for (let i = 0; i < 200 && !replies.some((r) => r["type"] === "welcome"); i++) await wait(5);
  let n = 0;
  const call = async (contract: string, method: string, payload: unknown): Promise<Reply> => {
    const id = `q${++n}`;
    client.postMessage({ v: 1, id, contract, contractVersion: 1, method, payload, ...(contract === "axis.worktrees" ? { idempotencyKey: randomUUID() } : {}) });
    for (let i = 0; i < 200 && !replies.some((r) => r["id"] === id); i++) await wait(5);
    const r = replies.find((x) => x["id"] === id);
    assert.ok(r, "no response");
    return r as unknown as Reply;
  };
  return {
    call: (method: string, payload: unknown = {}) => call("axis.audit", method, payload),
    callOn: call,
    internal,
    close: (): void => {
      daemon.stop();
      client.close();
    },
  };
}

async function withHost<T>(fn: (fix: HostFixture, s: HostServices) => Promise<T>, config: Record<string, unknown> = {}): Promise<T> {
  const fix = hostFixture({ config });
  const host = createDaemonHost(fix.config, fix.ports);
  try {
    return await fn(fix, await host.start());
  } finally {
    await host.stop();
    fix.cleanup();
  }
}

const append = (s: HostServices, n: number, tag = "e"): void => {
  for (let i = 1; i <= n; i++) must(s.audit).append({ actor: "daemon", action: "policy.decision", target: `t:${tag}${i}`, outcome: "success", payload: { tier: 0 } });
};

function tamper(fix: HostFixture, sql: string): void {
  const db = new DatabaseSync(join(fix.dataDir, "axis.db"));
  try {
    db.exec("DROP TRIGGER IF EXISTS audit_events_no_update; DROP TRIGGER IF EXISTS audit_events_no_delete;");
    db.exec(sql);
  } finally {
    db.close();
  }
}

test("status over the wire conforms, reports the anchor and carries nothing path-like", () =>
  withHost(async (fix, s) => {
    const w = await serve(s);
    try {
      append(s, 3);
      s.anchors.noteWrite();
      await wait(20);
      const r = await w.call("status");
      assert.equal(r.ok, true);
      const status = auditStatusResponseSchema.parse(r.result);
      assert.equal(status.head?.seq, 3);
      assert.deepEqual(status.anchor, status.head, "the supervisor acknowledged the newest head");
      assert.equal(status.lag, 0);
      assert.equal(status.stalled, false);
      assert.equal(status.degraded, null);
      const text = JSON.stringify(r.result);
      assert.ok(!text.includes(fix.root) && !text.includes(fix.dataDir) && !/[\\/]/.test(text.replace(/"/g, "")), "no path");
    } finally {
      w.close();
    }
  }));

test("list: cursor and limit bound the answer, oldest first, and the end is an empty list", () =>
  withHost(async (_fix, s) => {
    const w = await serve(s);
    try {
      append(s, 7);
      const page = async (p: object) => auditListResponseSchema.parse((await w.call("list", p)).result).events.map((e) => e.seq);
      assert.deepEqual(await page({ limit: 3 }), [1, 2, 3]);
      assert.deepEqual(await page({ afterSeq: 3, limit: 3 }), [4, 5, 6]);
      assert.deepEqual(await page({ afterSeq: 6, limit: 3 }), [7]);
      assert.deepEqual(await page({ afterSeq: 7 }), []);
      assert.deepEqual(await page({ afterSeq: 9_000_000_000 }), []);
      assert.deepEqual(await page({ afterSeq: 0, limit: 200 }), [1, 2, 3, 4, 5, 6, 7]);
      assert.deepEqual(await page({}), [1, 2, 3, 4, 5, 6, 7], "the default limit is bounded too");
    } finally {
      w.close();
    }
  }));

test("list: more events than one reply may hold are paged by the default limit, never returned whole", () =>
  withHost(async (_fix, s) => {
    const w = await serve(s);
    try {
      append(s, 150);
      const first = auditListResponseSchema.parse((await w.call("list", {})).result).events;
      assert.equal(first.length, 100);
      const big = auditListResponseSchema.parse((await w.call("list", { limit: 200 })).result).events;
      assert.equal(big.length, 150);
      assert.equal(big[0]?.seq, 1);
    } finally {
      w.close();
    }
  }));

test("list refuses a bad limit, a negative cursor and an unknown key with the daemon's closed error that echoes nothing", () =>
  withHost(async (_fix, s) => {
    const w = await serve(s);
    try {
      for (const payload of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { afterSeq: -1 }, { [CANARY]: 1 }, { afterSeq: CANARY }, { limit: CANARY }]) {
        const r = await w.call("list", payload);
        assert.equal(r.ok, false);
        assert.equal(r.error?.code, "E_INVALID_ARGUMENT");
        assert.ok(!JSON.stringify(r).includes(CANARY), "the caller's text is not echoed");
      }
    } finally {
      w.close();
    }
  }));

test("verify: ok on a sound chain, then the first bad seq and reason after an edit and after the tail is cut off the anchor", () =>
  withHost(async (fix, s) => {
    const w = await serve(s);
    try {
      append(s, 5);
      s.anchors.noteWrite();
      await wait(20);
      const ok = auditVerifyResponseSchema.parse((await w.call("verify")).result);
      assert.deepEqual(ok, { ok: true, count: 5, head: s.anchors.status().head });
      tamper(fix, "DELETE FROM audit_events WHERE seq > 3");
      const cut = auditVerifyResponseSchema.parse((await w.call("verify")).result);
      assert.deepEqual(cut, { ok: false, firstBadSeq: 4, reason: "truncated", checked: 3 });
      tamper(fix, "UPDATE audit_events SET target = 'x:y' WHERE seq = 2");
      const edited = auditVerifyResponseSchema.parse((await w.call("verify")).result);
      assert.deepEqual(edited, { ok: false, firstBadSeq: 2, reason: "hash_mismatch", checked: 1 });
    } finally {
      w.close();
    }
  }));

test("a read that fails answers a fixed E_INTERNAL: no database text, no path, no caller text", () =>
  withHost(async (fix, s) => {
    const w = await serve(s);
    try {
      append(s, 2);
      tamper(fix, "UPDATE audit_events SET payload = 'not json' WHERE seq = 1");
      for (const [method, payload] of [["list", { limit: 5 }], ["verify", {}]] as const) {
        const r = await w.call(method, payload);
        const body = JSON.stringify(r);
        assert.ok(!body.includes(fix.root) && !body.includes("SQLITE") && !body.includes("not json"), body);
      }
      const list = await w.call("list", { limit: 5 });
      assert.equal(list.ok, false);
      assert.equal(list.error?.code, "E_INTERNAL");
      assert.equal(list.error?.message, "The audit log is unavailable.");
    } finally {
      w.close();
    }
  }));

test("stalled: status says so, list and verify (tier 1) are still served, a tier 4 method answers E_UNAVAILABLE anchor_stalled", () =>
  withHost(
    async (fix, s) => {
      fix.supervisor.ackPuts = false;
      // A gate that implements the requirement (design 5.4): the stall check comes before issue and before execute.
      let gateCalls = 0;
      const gate: ApprovalGate = {
        issue: (input) => {
          s.anchors.check(input.tier);
          gateCalls++;
          return assert.fail("not reached while stalled");
        },
        execute: (input, _a, _c, action) => {
          s.anchors.check(input.tier);
          gateCalls++;
          return action({} as never);
        },
      };
      let ran = 0;
      const reached: Handler = () => void ran++;
      const w = await serve(s, (_d, r) => r.register("axis.worktrees", 1, { remove: reached }), gate);
      try {
        append(s, 4);
        s.anchors.noteWrite();
        const sr = await w.call("status");
        assert.equal(sr.ok, true, JSON.stringify(sr));
        const status = auditStatusResponseSchema.parse(sr.result);
        assert.equal(status.stalled, true);
        assert.ok(status.lag > 2);
        assert.equal((await w.call("list", {})).ok, true);
        assert.equal((await w.call("verify", {})).ok, true);
        const noApproval = await w.callOn("axis.worktrees", "remove", { id: "ws1" });
        assert.equal(noApproval.error?.code, "E_UNAVAILABLE", JSON.stringify(noApproval));
        assert.deepEqual(noApproval.error?.details, { reason: "anchor_stalled" });
        const refused = await w.callOn("axis.worktrees", "remove", { id: "ws1", approval: { challengeId: "A".repeat(43) } });
        assert.equal(refused.ok, false);
        assert.equal(refused.error?.code, "E_UNAVAILABLE", JSON.stringify(refused));
        assert.equal(refused.error?.message, "The audit anchor is not being acknowledged.");
        assert.deepEqual(refused.error?.details, { reason: "anchor_stalled" });
        assert.equal(ran, 0, "the tier 4 handler never ran");
        assert.equal(gateCalls, 0, "neither issue nor execute was reached");
        // Acks return: the supervisor acknowledges what it was sent (the head before the stall row), and the request is served.
        fix.peer.send({ type: "anchor.ack", seq: fix.supervisor.puts.at(-1)?.seq });
        await wait(20);
        assert.equal(s.anchors.status().stalled, false);
        const served = await w.callOn("axis.worktrees", "remove", { id: "ws1", approval: { challengeId: "A".repeat(43) } });
        assert.equal(ran, 1, JSON.stringify(served));
      } finally {
        w.close();
      }
    },
    { limits: { anchorMaxLagEvents: 2 } },
  ));

test("guardHandlers leaves tier 2 and below alone and refuses a method that does not exist", () =>
  withHost(async (_fix, s) => {
    const h: Handler = () => "ran";
    const wrapped = guardHandlers("axis.audit", 1, { list: h }, { check: () => assert.fail("tier 1 must not be checked") });
    assert.equal(wrapped["list"], h);
    assert.throws(() => guardHandlers("axis.audit", 1, { nope: h }, s.anchors), /No such method/);
    const calls: number[] = [];
    const guarded = guardHandlers("axis.worktrees", 1, { remove: h }, { check: (t) => void calls.push(t) });
    (guarded["remove"] as Handler)({} as never, {} as never);
    assert.deepEqual(calls, [4], "the tier is the contract's, not the caller's");
  }));

test("degraded: the three audit methods are served, status names the reason, the anchor is the supervisor's and nothing stalls", async () => {
  const fix = hostFixture();
  try {
    const seed = createDaemonHost(fix.config, fix.ports);
    const first = await seed.start();
    append(first, 4);
    const head = must(first.audit).head();
    await seed.stop();
    fix.supervisor.anchor = { seq: 99, hash: head?.hash ?? "" }; // the database is behind the anchor
    const host = createDaemonHost(fix.config, fix.ports);
    const s = await host.start();
    try {
      assert.equal(s.degraded, "database_behind_anchor");
      const w = await serve(s);
      try {
        const status = auditStatusResponseSchema.parse((await w.call("status")).result);
        assert.deepEqual(status.degraded, { reason: "database_behind_anchor" });
        assert.equal(status.stalled, false);
        assert.deepEqual(status.anchor, fix.supervisor.anchor);
        assert.equal(status.head?.seq, 4);
        assert.deepEqual(auditListResponseSchema.parse((await w.call("list", { limit: 2 })).result).events.map((e) => e.seq), [1, 2]);
        const v = auditVerifyResponseSchema.parse((await w.call("verify")).result);
        assert.equal(v.ok, false);
        if (!v.ok) assert.equal(v.reason, "truncated");
        assert.equal(fix.sent.filter((m) => m["type"] === "anchor.put").length, 0, "degraded never sends an anchor");
      } finally {
        w.close();
      }
    } finally {
      await host.stop();
    }
  } finally {
    fix.cleanup();
  }
});

test("a cancelled request is E_CANCELLED before anything is read", async () => {
  const { createAuditHandlers } = await import("../src/index.js");
  let reads = 0;
  const audit = { list: () => (reads++, []), verify: () => (reads++, { ok: true as const, count: 0, head: null }), head: () => (reads++, null) };
  const h = createAuditHandlers({ audit, anchors: { status: () => (reads++, { head: null, anchor: null, lag: 0, oldestUnackedAgeMs: null, stalled: false }) }, degraded: () => undefined, clock: { monotonic: () => 0 } });
  const ac = new AbortController();
  ac.abort();
  for (const m of [h.status, h.list, h.verify]) {
    assert.throws(() => m({ signal: ac.signal } as never, {} as never), (e: unknown) => (e as { code?: string }).code === "E_CANCELLED");
  }
  assert.equal(reads, 0);
});

test("the host hands out a narrow frozen guard: no put, no ack, no timer", () =>
  withHost(async (_fix, s) => {
    assert.deepEqual(Object.keys(s.anchors).sort(), ["check", "noteWrite", "status"]);
    assert.ok(Object.isFrozen(s.anchors));
    assert.equal(typeof s.anchor().ackedSeq, "number");
  }));

test("startup anchors a verified head that is newer than the supervisor's anchor, and sends nothing when they agree", async () => {
  const fix = hostFixture();
  try {
    const seed = createDaemonHost(fix.config, fix.ports);
    const first = await seed.start();
    append(first, 3);
    const second = must(first.audit).list({ limit: 2 })[1];
    const head = must(first.audit).head();
    await seed.stop();
    fix.supervisor.anchor = { seq: 2, hash: must(second).hash };
    fix.sent.length = 0;
    const host = createDaemonHost(fix.config, fix.ports);
    await host.start();
    await wait(20);
    assert.deepEqual(fix.sent.filter((m) => m["type"] === "anchor.put").map((m) => m["seq"]), [head?.seq]);
    await host.stop();
    fix.sent.length = 0;
    const again = createDaemonHost(fix.config, fix.ports);
    await again.start();
    await wait(20);
    assert.equal(fix.sent.filter((m) => m["type"] === "anchor.put").length, 0);
    await again.stop();
  } finally {
    fix.cleanup();
  }
});
