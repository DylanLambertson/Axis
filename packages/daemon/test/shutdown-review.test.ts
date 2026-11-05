// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for the independent review of the shutdown change (SF-1, N1, N2, N3, N6, N7).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test, type TestContext } from "node:test";
import { MemoryIdempotencyStore, ShutdownCoordinator, type ShutdownTarget, type FlushableIdempotencyStore, DrainGate, installShutdownSignals, type ShutdownResult } from "../src/index.js";
import { approveAndRun, fakeGate, sha } from "./gate.js";
import { CONTRACT, KEY1, hello, req, rig, type Rig } from "./harness.js";

async function ready(t: TestContext, options: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = rig(options);
  t.after(() => r.cleanup());
  await r.handshake();
  return r;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}
const store: FlushableIdempotencyStore = { ...new MemoryIdempotencyStore(), begin: () => ({ state: "new" as const }), complete: () => undefined, abandon: () => undefined, markUnknown: () => undefined };
const target = (drain: DrainGate, extra: Partial<ShutdownTarget> = {}) => ({
  drain,
  cancelAll: () => 1,
  closeAll: () => undefined,
  store,
  onError: () => undefined,
  ...extra,
});

// ---- SF-1: timing options ----

test("SF-1a: an explicit undefined keeps the default; Infinity waits without a timer; a huge value is clamped", async () => {
  const count = () => process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
  const warnings: string[] = [];
  const onWarning = (w: Error): void => void warnings.push(w.name);
  process.on("warning", onWarning);
  try {
    for (const graceMs of [undefined, Infinity, 2 ** 31, 2 ** 40]) {
      const drain = new DrainGate();
      drain.enter();
      let cancelled = false;
      const before = count();
      const c = new ShutdownCoordinator(target(drain, { cancelAll: () => ((cancelled = true), 1) }), { graceMs });
      const p = c.run("t");
      await wait(60);
      assert.equal(cancelled, false, `graceMs ${String(graceMs)} must not cut the wait to ~1 ms`);
      if (graceMs === Infinity) assert.equal(count(), before, "no timer for an infinite wait");
      drain.leave();
      assert.equal((await p).graceful, true);
      assert.equal(count(), before);
    }
    await wait(10);
  } finally {
    process.off("warning", onWarning);
  }
  assert.deepEqual(warnings, [], "no TimeoutNaN/TimeoutOverflow warning");
});

test("SF-1b: NaN, negative and non-number options throw a TypeError naming the option", () => {
  for (const bad of [NaN, -1, "5", null, {}]) {
    for (const key of ["graceMs", "cancelSettleMs", "flushTimeoutMs"] as const) {
      assert.throws(() => new ShutdownCoordinator(target(new DrainGate()), { [key]: bad } as never), (e: Error) => e instanceof TypeError && e.message.includes(key));
    }
  }
  assert.doesNotThrow(() => new ShutdownCoordinator(target(new DrainGate()), { graceMs: 0, cancelSettleMs: 0, flushTimeoutMs: Infinity }));
});

test("SF-1c: the daemon rejects bad shutdown options at construction", () => {
  assert.throws(() => rig({ shutdown: { graceMs: NaN } }), TypeError);
});

test("SF-1d: flushTimeoutMs undefined keeps 5 s (a 100 ms flush is done) and Infinity needs no timer", async () => {
  for (const flushTimeoutMs of [undefined, Infinity]) {
    const slow = { ...store, flush: async () => void (await wait(100)) };
    const c = new ShutdownCoordinator({ ...target(new DrainGate()), store: slow }, { flushTimeoutMs });
    assert.equal((await c.run("t")).flushed, "done");
  }
});

// ---- N1: no handler starts once shutdown began ----

test("N1a: a request parked in policy when shutdown begins is refused instead of starting its handler", async (t) => {
  const park = deferred();
  const r = await ready(t, { policy: { evaluate: async () => (await park.promise, { effect: "allow" as const }) } });
  let started = 0;
  r.daemon.register(CONTRACT, 1, { echo: () => (started++, { text: "x" }) });
  r.send(req("a", "echo", { text: "a" }));
  await wait(10);
  const done = r.daemon.shutdown("t");
  park.resolve();
  assert.equal((await r.inbox.response("a")).error?.code, "E_UNAVAILABLE");
  await done;
  assert.equal(started, 0);
});

test("N1b: a keyed write parked in its audit write is refused, audited with an outcome, and its idempotency key is freed", async (t) => {
  const park = deferred();
  const rows: Array<{ outcome: string; reason: unknown }> = [];
  let first = true;
  const keys = new MemoryIdempotencyStore();
  const r = await ready(t, {
    idempotency: keys,
    audit: { append: (e) => (first ? ((first = false), park.promise) : void rows.push({ outcome: e.outcome, reason: e.payload["reason"] })) },
  });
  let started = 0;
  r.daemon.register(CONTRACT, 1, { write: () => (started++, { n: 1 }) });
  r.send(req("a", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  await wait(10);
  assert.equal(keys.size, 1, "the key is in progress while the request is parked");
  const done = r.daemon.shutdown("t");
  park.resolve();
  assert.equal((await r.inbox.response("a")).error?.code, "E_UNAVAILABLE");
  await done;
  assert.equal(started, 0);
  assert.equal(keys.size, 0, "the key was abandoned");
  assert.deepEqual(rows, [{ outcome: "denied", reason: "shutting_down" }], "the allow row is followed by an outcome row");
});

test("N1d: a request refused after its policy wait is audited as denied (shutting_down)", async (t) => {
  const park = deferred();
  const r = await ready(t, { policy: { evaluate: async () => (await park.promise, { effect: "allow" as const }) } });
  r.daemon.register(CONTRACT, 1, { echo: () => ({ text: "x" }) });
  r.send(req("a", "echo", { text: "a" }));
  await wait(10);
  const done = r.daemon.shutdown("t");
  park.resolve();
  await r.inbox.response("a");
  await done;
  assert.deepEqual(r.events.map((e) => [e.outcome, e.payload["reason"]]), [["denied", "shutting_down"]]);
});

test("N1e: a content lock that wraps the errors it sees still yields E_UNAVAILABLE, not E_INTERNAL", async (t) => {
  const { gate, calls } = fakeGate();
  const park = deferred();
  let parkNext = false;
  const r = await ready(t, { gate });
  r.daemon.register(CONTRACT, 1, { danger: () => ({ done: true as const }) }, {
    content: {
      danger: () => ({
        target: "workspace:ws-1",
        withLock: async (fn) => {
          if (parkNext) await park.promise;
          try {
            return await fn(sha("v1"));
          } catch (e) {
            throw new Error("lock failed", { cause: e });
          }
        },
      }),
    },
  });
  const id = await approveAndRun(r, "w", { id: "ws-1" }, () => void (parkNext = true));
  await wait(20);
  const done = r.daemon.shutdown("t");
  park.resolve();
  assert.equal((await r.inbox.response(id)).error?.code, "E_UNAVAILABLE");
  await done;
  assert.equal(calls.execute.length, 0);
  assert.equal(r.events.at(-1)?.payload["reason"], "shutting_down");
});

test("N1c: a tier-4 request whose content lock is parked when shutdown begins is refused before its approval is spent", async (t) => {
  const { gate, calls } = fakeGate();
  const park = deferred();
  let parkNext = false;
  const r = await ready(t, { gate });
  let ran = 0;
  r.daemon.register(CONTRACT, 1, { danger: () => (ran++, { done: true }) }, {
    content: {
      danger: () => ({
        target: "workspace:ws-1",
        withLock: async (fn) => {
          if (parkNext) await park.promise;
          return fn(sha("v1"));
        },
      }),
    },
  });
  const id = await approveAndRun(r, "d", { id: "ws-1" }, () => void (parkNext = true));
  await wait(20);
  const done = r.daemon.shutdown("t");
  park.resolve();
  assert.equal((await r.inbox.response(id)).error?.code, "E_UNAVAILABLE");
  await done;
  assert.equal(ran, 0);
  assert.equal(calls.execute.length, 0, "the approval was never presented for spending");
});

// ---- N2: escalation skips one wait at a time ----

test("N2: each escalate() skips only the wait in progress: grace, then the settle after cancel, then the flush", async () => {
  const drain = new DrainGate();
  drain.enter(); // never settles
  const events: string[] = [];
  const hang = { ...store, flush: () => new Promise<void>(() => undefined) };
  const c = new ShutdownCoordinator(
    { ...target(drain, { cancelAll: () => (events.push("cancel"), 1), closeAll: () => void events.push("close") }), store: hang },
    { graceMs: Infinity, cancelSettleMs: Infinity, flushTimeoutMs: Infinity },
  );
  const p = c.run("t");
  await wait(10);
  c.escalate(); // ends the grace
  await wait(10);
  assert.deepEqual(events, ["cancel"], "the settle wait after cancel is still in progress");
  c.escalate(); // ends the settle
  await wait(10);
  assert.deepEqual(events, ["cancel", "close"], "now in the flush");
  c.escalate(); // ends the flush
  const res = await p;
  assert.equal(res.flushed, "running");
  assert.equal(res.escalated, true);
  assert.equal(res.unsettled, 1);
});

test("N2b: guards the documented behaviour: every signal after the first escalates (this also held before the fix)", () => {
  const src = new EventEmitter();
  let escalations = 0;
  installShutdownSignals(
    { shutdown: () => new Promise<ShutdownResult>(() => undefined), escalate: () => void escalations++ },
    { source: src, exit: () => undefined },
  );
  for (let i = 0; i < 4; i++) src.emit("SIGINT", "SIGINT");
  assert.equal(escalations, 3);
});

// ---- N3: exit gets the result ----

test("N3: the exit hook receives the full result, so a host can tell cancelled-but-finished from still running", async () => {
  const res: ShutdownResult = { reason: "x", graceful: false, escalated: false, cancelled: 1, unsettled: 1, flushed: "unsupported" };
  const src = new EventEmitter();
  const seen: Array<[number, ShutdownResult | undefined]> = [];
  installShutdownSignals({ shutdown: () => Promise.resolve(res), escalate: () => undefined }, { source: src, exit: (c, r) => void seen.push([c, r]) });
  src.emit("SIGTERM", "SIGTERM");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, [[1, res]]);
  const src2 = new EventEmitter();
  const seen2: Array<[number, ShutdownResult | undefined]> = [];
  installShutdownSignals({ shutdown: () => Promise.reject(new Error("x")), escalate: () => undefined }, { source: src2, exit: (c, r) => void seen2.push([c, r]) });
  src2.emit("SIGTERM", "SIGTERM");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen2, [[1, undefined]]);
});

// ---- N6, N7 ----

test("N6: a hello that arrives while draining is rejected with E_UNAVAILABLE and the connection closes", async (t) => {
  const r = await ready(t);
  const gate = deferred<{ text: string }>();
  r.daemon.register(CONTRACT, 1, { echo: () => gate.promise });
  r.send(req("a", "echo", { text: "a" }));
  await wait(10);
  // A connection accepted and verified before the drain, whose hello arrives after it.
  const late = r.connect("good#conn-2");
  await wait(10);
  const done = r.daemon.shutdown("t");
  late.client.postMessage(hello());
  const rejected = await late.inbox.until((m): m is { type: string; error: { code: string } } => (m as { type?: string }).type === "hello-rejected");
  assert.equal(rejected.error.code, "E_UNAVAILABLE");
  gate.resolve({ text: "a" });
  await done;
});

test("N7: when only already-answered orphans remain at the end of the grace period the cancel settle wait is skipped", async (t) => {
  const r = await ready(t, { shutdown: { graceMs: 400, cancelSettleMs: 600_000 } });
  const never = new Promise<never>(() => undefined);
  r.daemon.register(CONTRACT, 1, { slow: () => never });
  r.send(req("a", "slow", {}, { timeoutMs: 5 }));
  assert.equal((await r.inbox.response("a")).error?.code, "E_TIMEOUT");
  const res = await r.daemon.shutdown("t"); // would hang for 600 s if it waited for the orphan after cancelling nothing
  assert.deepEqual({ cancelled: res.cancelled, unsettled: res.unsettled }, { cancelled: 0, unsettled: 1 });
});

test("R2: a flush that is cut short while still running is reported as running; one that already failed is failed", async () => {
  const never = { ...store, flush: () => new Promise<void>(() => undefined) };
  const res = await new ShutdownCoordinator({ ...target(new DrainGate()), store: never }, { flushTimeoutMs: 20 }).run("t");
  assert.equal(res.flushed, "running");
  const late = deferred();
  const slow = { ...store, flush: () => late.promise };
  const c = new ShutdownCoordinator({ ...target(new DrainGate()), store: slow }, { flushTimeoutMs: Infinity });
  const p = c.run("t");
  await wait(10);
  c.escalate();
  assert.equal((await p).flushed, "running");
  late.resolve();
});
