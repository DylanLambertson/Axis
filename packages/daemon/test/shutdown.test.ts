// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DrainGate, ShutdownCoordinator, type FlushableIdempotencyStore, type IdempotencyKey, MemoryIdempotencyStore } from "../src/index.js";
import { CONTRACT, KEY1, req, rig, type Rig } from "./harness.js";

async function ready(t: TestContext, options: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = rig(options);
  t.after(() => r.cleanup());
  await r.handshake();
  return r;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise<never>(() => undefined);
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}
const fast = { shutdown: { graceMs: 30, cancelSettleMs: 30, flushTimeoutMs: 30 } };

test("SD1: new requests are refused with E_UNAVAILABLE and no handler starts; in-flight handlers settle and are answered", async (t) => {
  const r = await ready(t);
  const gate = deferred<{ text: string }>();
  let started = 0;
  r.daemon.register(CONTRACT, 1, { echo: () => (started++, gate.promise) });
  r.send(req("a", "echo", { text: "a" }));
  await wait(20);
  assert.equal(started, 1);
  const done = r.daemon.shutdown("test");
  r.send(req("b", "echo", { text: "b" }));
  assert.equal((await r.inbox.response("b")).error?.code, "E_UNAVAILABLE");
  assert.equal(started, 1, "no handler started after shutdown began");
  gate.resolve({ text: "a" });
  const res = await done;
  assert.equal((await r.inbox.response("a")).ok, true);
  assert.deepEqual({ graceful: res.graceful, cancelled: res.cancelled, unsettled: res.unsettled, reason: res.reason }, { graceful: true, cancelled: 0, unsettled: 0, reason: "test" });
  assert.equal(r.daemon.connectionCount, 0);
});

test("SD2: new connections are closed while draining and after shutdown", async (t) => {
  const r = await ready(t);
  const gate = deferred<{ text: string }>();
  r.daemon.register(CONTRACT, 1, { echo: () => gate.promise });
  r.send(req("a", "echo", { text: "a" }));
  await wait(20);
  const done = r.daemon.shutdown("test");
  const late = r.connect("good#conn-2");
  assert.equal(await late.inbox.closedWithin(), true);
  gate.resolve({ text: "a" });
  await done;
  const after = r.connect("good#conn-3");
  assert.equal(await after.inbox.closedWithin(), true);
});

test("SD3: at the end of the grace period remaining handlers are cancelled through the cancel path and callers get E_CANCELLED", async (t) => {
  const r = await ready(t, fast);
  let aborted = false;
  r.daemon.register(CONTRACT, 1, {
    echo: (c) =>
      new Promise((resolve) => {
        c.signal.addEventListener("abort", () => ((aborted = true), resolve({ text: "late" })));
      }),
  });
  r.send(req("a", "echo", { text: "a" }));
  await wait(10);
  const res = await r.daemon.shutdown("test");
  assert.equal(aborted, true);
  assert.equal((await r.inbox.response("a")).error?.code, "E_CANCELLED");
  assert.deepEqual({ graceful: res.graceful, cancelled: res.cancelled, unsettled: res.unsettled }, { graceful: false, cancelled: 1, unsettled: 0 });
});

test("SD4: a handler that ignores cancellation keeps its slot and orphan count; shutdown still finishes and reports it", async (t) => {
  const r = await ready(t, { ...fast, limits: { maxInFlight: 1 } });
  const release = deferred<{ text: string }>();
  r.daemon.register(CONTRACT, 1, { echo: () => release.promise });
  r.send(req("a", "echo", { text: "a" }));
  await wait(10);
  const res = await r.daemon.shutdown("test");
  assert.equal(res.unsettled, 1);
  assert.equal(res.graceful, false);
  assert.equal(r.daemon.orphanedHandlers, 1, "the slot is not freed while the handler runs");
  release.resolve({ text: "a" });
  await wait(20);
  assert.equal(r.daemon.orphanedHandlers, 0, "released when it finally settles");
});

test("SD5: shutdown is idempotent: same promise, first reason wins, escalate before/after is harmless", async (t) => {
  const r = await ready(t);
  r.daemon.escalate(); // before: no effect, must not poison the later shutdown
  const gate = deferred<{ text: string }>();
  r.daemon.register(CONTRACT, 1, { echo: () => gate.promise });
  r.send(req("a", "echo", { text: "a" }));
  await wait(10);
  const p1 = r.daemon.shutdown("first");
  const p2 = r.daemon.shutdown("second");
  assert.equal(p1, p2);
  await wait(30);
  gate.resolve({ text: "a" });
  const res = await p1;
  assert.equal(res.reason, "first");
  assert.equal(res.escalated, false);
  r.daemon.escalate();
  assert.equal(await r.daemon.shutdown("third"), res);
});

test("SD6: escalate skips the grace wait (a long grace ends at once) and still cancels", async (t) => {
  const r = await ready(t, { shutdown: { graceMs: 600_000, cancelSettleMs: 600_000 } });
  const ignore = deferred<{ text: string }>();
  r.daemon.register(CONTRACT, 1, { echo: () => ignore.promise });
  r.send(req("a", "echo", { text: "a" }));
  await wait(10);
  const done = r.daemon.shutdown("sig");
  await wait(10);
  r.daemon.escalate(); // ends the grace wait; the cancel then waits for settle
  await wait(10);
  r.daemon.escalate(); // ends the settle wait
  const res = await done;
  assert.equal(res.escalated, true);
  assert.equal(res.cancelled, 1);
  assert.equal((await r.inbox.response("a")).error?.code, "E_CANCELLED");
  ignore.resolve({ text: "a" });
});

test("SD7: a request whose handler is not started when the grace ends never starts it", async (t) => {
  const audit = deferred();
  const r = await ready(t, { ...fast, audit: { append: () => audit.promise } });
  let started = 0;
  r.daemon.register(CONTRACT, 1, { echo: () => (started++, { text: "x" }) });
  r.send(req("a", "echo", { text: "a" })); // parked in the audit sink
  await wait(10);
  const res = await r.daemon.shutdown("test");
  assert.equal(started, 0);
  assert.equal(res.cancelled, 1);
  audit.resolve();
  await wait(10);
  assert.equal(started, 0);
});

class FlushStore extends MemoryIdempotencyStore {
  log: string[] = [];
  flushImpl: () => void | Promise<void> = () => undefined;
  override complete(key: IdempotencyKey, result: never, origin: string): void {
    this.log.push("complete");
    super.complete(key, result, origin);
  }
  flush(): void | Promise<void> {
    this.log.push("flush");
    return this.flushImpl();
  }
}

test("SD8: the idempotency store is flushed once, after in-flight work completed; a missing flush is reported as unsupported", async (t) => {
  const store = new FlushStore();
  const r = await ready(t, { idempotency: store });
  const gate = deferred<{ n: number }>();
  r.daemon.register(CONTRACT, 1, { write: () => gate.promise });
  r.send(req("w", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  await wait(10);
  const done = r.daemon.shutdown("test");
  gate.resolve({ n: 1 });
  const res = await done;
  assert.deepEqual(store.log, ["complete", "flush"]);
  assert.equal(res.flushed, "done");
  const plain = await ready(t);
  assert.equal((await plain.daemon.shutdown("x")).flushed, "unsupported");
});

test("SD9: a failing or hanging flush is reported, not thrown", async (t) => {
  const store = new FlushStore();
  const r = await ready(t, { idempotency: store, ...fast });
  store.flushImpl = () => {
    throw new Error("disk full");
  };
  assert.equal((await r.daemon.shutdown("a")).flushed, "failed");
  assert.equal(r.internal.at(-1)?.correlationId, "shutdown-flush");
  const store2 = new FlushStore();
  const r2 = await ready(t, { idempotency: store2, ...fast });
  store2.flushImpl = never;
  assert.equal((await r2.daemon.shutdown("b")).flushed, "failed");
});

test("SD10: shutdown leaves no timers behind, even when it cancels and flushes", async () => {
  const count = () => process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
  const drain = new DrainGate();
  drain.enter();
  const store: FlushableIdempotencyStore = { ...new MemoryIdempotencyStore(), begin: () => ({ state: "new" }), complete: () => undefined, abandon: () => undefined, flush: () => undefined };
  const before = count();
  const c = new ShutdownCoordinator(
    { drain, cancelAll: () => 1, closeAll: () => undefined, store, onError: () => undefined },
    { graceMs: 10, cancelSettleMs: 10, flushTimeoutMs: 10 },
  );
  const p = c.run("t");
  assert.equal(count() > before, true, "a wait is armed while handlers run");
  const res = await p;
  assert.equal(res.unsettled, 1);
  assert.equal(count(), before);
  // Settling inside the grace period also clears its timer.
  const d2 = new DrainGate();
  d2.enter();
  const c2 = new ShutdownCoordinator({ drain: d2, cancelAll: () => 0, closeAll: () => undefined, store, onError: () => undefined }, { graceMs: 60_000 });
  const p2 = c2.run("t");
  d2.leave();
  assert.equal((await p2).graceful, true);
  assert.equal(count(), before);
});

test("SD11: shutdown with nothing in flight finishes at once and Daemon.stop() afterwards is harmless", async (t) => {
  const r = await ready(t);
  const res = await r.daemon.shutdown("idle");
  assert.equal(res.graceful, true);
  r.daemon.stop();
  assert.equal(await r.inbox.closedWithin(), true);
});
