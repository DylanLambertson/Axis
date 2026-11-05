// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase, type ChainHead, type DatabaseSync } from "@axis/audit";
import type { Handler } from "@axis/daemon";
import { auditListResponseSchema, auditVerifyResponseSchema } from "@axis/protocol";
import { createAuditHandlers, createDaemonHost, createHandlerRegistrar, type AuditHandlerDeps, type AuditReader } from "../src/index.js";
import { hostFixture } from "../testing/host-fixture.js";
import { must, wait } from "./helpers.js";

function memoryLog(n: number): { db: DatabaseSync; log: AuditLog } {
  const db = openDatabase(":memory:");
  const log = new AuditLog(db, { now: () => new Date("2026-11-02T00:00:00.000Z") });
  db.exec("BEGIN");
  for (let i = 1; i <= n; i++) log.append({ actor: "daemon", action: "policy.decision", target: `t:${i}`, outcome: "success", payload: { tier: 0 } });
  db.exec("COMMIT");
  return { db, log };
}
const unlock = (db: DatabaseSync): void => db.exec("DROP TRIGGER audit_events_no_update; DROP TRIGGER audit_events_no_delete");

const idle = { head: null, anchor: null, lag: 0, oldestUnackedAgeMs: null, stalled: false } as const;

function rig(log: AuditLog, over: Partial<AuditHandlerDeps> = {}) {
  const verifyCalls: Array<{ from?: ChainHead; limit?: number }> = [];
  let now = 0;
  const audit: AuditReader = {
    list: (o) => log.list(o),
    head: () => log.head(),
    verify: (o) => (verifyCalls.push({ ...(o?.from === undefined ? {} : { from: o.from }), ...(o?.limit === undefined ? {} : { limit: o.limit }) }), log.verify(o)),
  };
  const handlers = createAuditHandlers({
    audit,
    anchors: { status: () => idle },
    degraded: () => undefined,
    clock: { monotonic: () => now },
    ...over,
  });
  const run = (signal: AbortSignal = new AbortController().signal) => (handlers.verify as Handler)({ signal } as never, {} as never) as Promise<unknown>;
  return { handlers, verifyCalls, run, advance: (ms: number) => void (now += ms) };
}
const code = (e: unknown): string | undefined => (e as { code?: string }).code;

test("verify of a 50k-event log never holds the event loop for more than a slice", async () => {
  const { log } = memoryLog(50_000);
  const t0 = performance.now();
  assert.equal(log.verify().ok, true);
  const whole = performance.now() - t0;
  const r = rig(log, { sliceEvents: 2000 });
  let maxGap = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const t = performance.now();
    maxGap = Math.max(maxGap, t - last);
    last = t;
  }, 1);
  try {
    const out = auditVerifyResponseSchema.parse(await r.run());
    assert.equal(out.ok, true);
    assert.equal(out.ok && out.count, 50_000);
  } finally {
    clearInterval(timer);
  }
  assert.equal(r.verifyCalls.length, 25);
  assert.ok(r.verifyCalls.every((c) => c.limit === 2000));
  assert.ok(maxGap < whole / 3, `max gap ${maxGap.toFixed(1)} ms against ${whole.toFixed(1)} ms for one scan`);
});

test("cancellation between slices ends the scan with E_CANCELLED and frees the slot", async () => {
  const { log } = memoryLog(5000);
  const ac = new AbortController();
  let yields = 0;
  const r = rig(log, { sliceEvents: 500, yieldNow: async () => void (++yields === 2 && ac.abort()) });
  await assert.rejects(r.run(ac.signal), (e) => code(e) === "E_CANCELLED");
  assert.equal(r.verifyCalls.length, 2, "stopped after the slice that preceded the abort");
  assert.equal(auditVerifyResponseSchema.parse(await r.run()).ok, true, "the slot is free again");
});

test("a second verify while one runs is refused with a fixed E_BACKPRESSURE, never queued", async () => {
  const { log } = memoryLog(2000);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => void (release = resolve));
  const r = rig(log, { sliceEvents: 500, yieldNow: () => gate });
  const first = r.run();
  assert.throws(() => r.run(), (e) => code(e) === "E_BACKPRESSURE" && (e as Error).message === "A verification is already running." && JSON.stringify((e as { details?: unknown }).details) === '{"retryAfterMs":1000}');
  release();
  assert.equal(auditVerifyResponseSchema.parse(await first).ok, true);
  assert.equal(auditVerifyResponseSchema.parse(await r.run()).ok, true, "free after the first finished");
});

test("the verified head is cached: later calls check only new events, a full re-scan comes after the interval", async () => {
  const { db, log } = memoryLog(3000);
  const r = rig(log, { sliceEvents: 1000, fullRescanMs: 600_000 });
  await r.run();
  assert.deepEqual(r.verifyCalls.map((c) => c.from?.seq), [undefined, 1000, 2000]);
  r.verifyCalls.length = 0;
  for (let i = 0; i < 5; i++) log.append({ actor: "daemon", action: "policy.decision", target: `n:${i}`, outcome: "success", payload: { tier: 0 } });
  const out = auditVerifyResponseSchema.parse(await r.run());
  assert.deepEqual(r.verifyCalls.map((c) => c.from?.seq), [3000], "only the events after the cached head");
  assert.deepEqual(out, { ok: true, count: 3005, head: log.head() });
  // An edit before the cached head is invisible to the incremental call (the documented trade) and found by the full re-scan.
  unlock(db);
  db.exec("UPDATE audit_events SET target = 'x:y' WHERE seq = 100");
  r.verifyCalls.length = 0;
  assert.equal(auditVerifyResponseSchema.parse(await r.run()).ok, true);
  r.advance(599_999);
  r.verifyCalls.length = 0;
  assert.equal(auditVerifyResponseSchema.parse(await r.run()).ok, true);
  assert.equal(r.verifyCalls[0]?.from?.seq, 3005, "still incremental one millisecond before the interval");
  r.advance(1);
  r.verifyCalls.length = 0;
  const found = auditVerifyResponseSchema.parse(await r.run());
  assert.equal(r.verifyCalls[0]?.from, undefined, "a full re-scan from the first event");
  assert.deepEqual(found, { ok: false, firstBadSeq: 100, reason: "hash_mismatch", checked: 99 });
});

test("a cached head that is no longer on the chain makes one full re-scan, and its result is reported", async () => {
  const { db, log } = memoryLog(3000);
  const r = rig(log, { sliceEvents: 1000 });
  await r.run();
  unlock(db);
  db.exec("DELETE FROM audit_events WHERE seq > 2500");
  r.verifyCalls.length = 0;
  const out = auditVerifyResponseSchema.parse(await r.run());
  assert.deepEqual(out, { ok: true, count: 2500, head: log.head() });
  assert.equal(r.verifyCalls[0]?.from?.seq, 3000, "tried the cached head first");
  assert.equal(r.verifyCalls[1]?.from, undefined, "then started over");
});

test("a failure in a later slice reports the absolute number of events checked", async () => {
  const { db, log } = memoryLog(3000);
  unlock(db);
  db.exec("UPDATE audit_events SET target = 'x:y' WHERE seq = 2200");
  const out = auditVerifyResponseSchema.parse(await rig(log, { sliceEvents: 1000 }).run());
  assert.deepEqual(out, { ok: false, firstBadSeq: 2200, reason: "hash_mismatch", checked: 2199 });
});

test("a verification past its deadline ends with E_TIMEOUT and keeps its progress", async () => {
  const { log } = memoryLog(4000);
  let t = 0;
  const r = rig(log, { sliceEvents: 1000, deadlineMs: 25, clock: { monotonic: () => (t += 10) } });
  await assert.rejects(r.run(), (e) => code(e) === "E_TIMEOUT" && (e as Error).message === "The verification took too long.");
  assert.ok(r.verifyCalls.length >= 1 && r.verifyCalls.length < 4);
  const done = r.verifyCalls.length;
  const again = rig(log, { sliceEvents: 1000 });
  assert.equal(done > 0, true);
  assert.equal(auditVerifyResponseSchema.parse(await again.run()).ok, true);
});

const bigEvent = (seq: number) => ({
  seq,
  ts: "2026-11-02T00:00:00.000Z",
  actor: "daemon" as const,
  action: "policy.decision",
  target: "t:x",
  outcome: "success" as const,
  payload: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, "x".repeat(2000)])),
  prevHash: "a".repeat(64),
  hash: "b".repeat(64),
});

test("list trims a reply to fit one message: a contiguous prefix whose last seq is the next cursor", async () => {
  const events = Array.from({ length: 200 }, (_, i) => bigEvent(i + 1));
  const audit: AuditReader = { list: () => events as never, verify: () => ({ ok: true, count: 0, head: null }), head: () => null };
  const h = createAuditHandlers({ audit, anchors: { status: () => idle }, degraded: () => undefined, clock: { monotonic: () => 0 } });
  const out = auditListResponseSchema.parse(await (h.list as Handler)({ signal: new AbortController().signal } as never, { limit: 200 } as never));
  assert.ok(out.events.length > 0 && out.events.length < 200, `${out.events.length} events`);
  assert.deepEqual(out.events.map((e) => e.seq), Array.from({ length: out.events.length }, (_, i) => i + 1));
  assert.ok(JSON.stringify(out).length <= 1_048_576);
  // One event that cannot fit is an internal error, never an empty page that would stall the cursor.
  const tiny = createAuditHandlers({ audit, anchors: { status: () => idle }, degraded: () => undefined, clock: { monotonic: () => 0 }, maxReplyBytes: 100 });
  assert.throws(() => (tiny.list as Handler)({ signal: new AbortController().signal } as never, { limit: 5 } as never), (e) => code(e) === "E_INTERNAL");
});

test("the registrar guards every tier 3 and above handler itself: an unguarded one cannot be served while stalled", () => {
  const registered: Array<{ contract: string; handlers: Record<string, Handler> }> = [];
  let stalled = false;
  const guard = {
    check: (tier: number) => {
      if (stalled && tier >= 3) throw Object.assign(new Error("stalled"), { code: "E_UNAVAILABLE" });
    },
  };
  const registrar = createHandlerRegistrar({ register: (contract: string, _v: number, handlers: Readonly<Record<string, Handler>>) => void registered.push({ contract, handlers: { ...handlers } }) }, guard);
  let ran = 0;
  const raw: Handler = () => void ran++;
  registrar.register("axis.worktrees", 1, { remove: raw }); // tier 4, passed raw
  registrar.register("axis.audit", 1, { list: raw }); // tier 1
  const [wt, au] = registered;
  assert.notEqual(wt?.handlers["remove"], raw, "tier 4 was wrapped");
  assert.equal(au?.handlers["list"], raw, "tier 1 is untouched");
  stalled = true;
  assert.throws(() => (wt?.handlers["remove"] as Handler)({} as never, {} as never), (e) => code(e) === "E_UNAVAILABLE");
  assert.equal(ran, 0);
  stalled = false;
  (wt?.handlers["remove"] as Handler)({} as never, {} as never);
  assert.equal(ran, 1);
  assert.throws(() => registrar.register("axis.audit", 1, { nope: raw }), /No such method/);
  assert.ok(Object.isFrozen(registrar));
});

test("a handler that is already guarded is not wrapped twice", () => {
  const seen: Handler[] = [];
  let checks = 0;
  const guard = { check: () => void checks++ };
  const first = createHandlerRegistrar({ register: (_c: string, _v: number, h: Readonly<Record<string, Handler>>) => void seen.push(h["remove"] as Handler) }, guard);
  first.register("axis.worktrees", 1, { remove: () => undefined });
  const second = createHandlerRegistrar({ register: (_c: string, _v: number, h: Readonly<Record<string, Handler>>) => void seen.push(h["remove"] as Handler) }, guard);
  second.register("axis.worktrees", 1, { remove: seen[0] as Handler });
  assert.equal(seen[1], seen[0]);
  (seen[1] as Handler)({} as never, {} as never);
  assert.equal(checks, 1);
});

test("the stall and resume rows are written with their one fixed field and nothing else", async () => {
  const fix = hostFixture({ config: { limits: { anchorMaxLagEvents: 2 } } });
  const host = createDaemonHost(fix.config, fix.ports);
  try {
    fix.supervisor.ackPuts = false;
    const s = await host.start();
    for (let i = 0; i < 4; i++) must(s.audit).append({ actor: "daemon", action: "policy.decision", target: `t:${i}`, outcome: "success", payload: { tier: 0 } });
    s.anchors.noteWrite();
    assert.equal(s.anchors.status().stalled, true);
    await wait(20);
    fix.peer.send({ type: "anchor.ack", seq: must(fix.supervisor.puts.at(-1)).seq });
    await wait(20);
    assert.equal(s.anchors.status().stalled, false);
    const rows = s.auditRead.list({ limit: 100 }).filter((e) => e.action.startsWith("anchor."));
    assert.deepEqual(rows.map((e) => [e.action, e.actor, e.target, e.outcome, e.payload]), [
      ["anchor.stalled", "daemon", "daemon:anchor", "success", { reason: "anchor_stalled" }],
      ["anchor.resumed", "daemon", "daemon:anchor", "success", { code: "resumed" }],
    ]);
  } finally {
    await host.stop();
    fix.cleanup();
  }
});
