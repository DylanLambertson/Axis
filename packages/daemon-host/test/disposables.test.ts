// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { AxisError } from "@axis/audit";
import { Disposables } from "../src/index.js";
import { processSnapshot, wait } from "./helpers.js";

test("disposes in reverse order of registration", async () => {
  const d = new Disposables();
  const order: string[] = [];
  d.add(() => void order.push("first"), "first");
  d.add(async () => { await wait(5); order.push("second"); }, "second");
  d.add(() => void order.push("third"), "third");
  assert.equal(d.size, 3);
  const r = await d.dispose();
  assert.deepEqual(order, ["third", "second", "first"], "one at a time, newest first, each awaited");
  assert.deepEqual(r, { disposed: 3, failures: [] });
  assert.equal(d.size, 0);
  assert.equal(d.disposed, true);
});

test("dispose is idempotent and concurrent calls share one run", async () => {
  const d = new Disposables();
  let runs = 0;
  d.add(async () => { runs++; await wait(5); });
  const [a, b] = await Promise.all([d.dispose(), d.dispose()]);
  const c = await d.dispose();
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(runs, 1);
});

test("an empty registry disposes cleanly", async () => {
  assert.deepEqual(await new Disposables().dispose(), { disposed: 0, failures: [] });
});

test("errors during dispose are collected, summarised and do not stop the others", async () => {
  const d = new Disposables();
  const ran: string[] = [];
  const secret = ["sk", "ant", "api03", "Zq".repeat(20)].join("-");
  d.add(() => void ran.push("a"), "a");
  d.add(() => { throw new AxisError("E_UNAVAILABLE", secret); }, "throws");
  d.add(async () => { throw Object.assign(new Error(secret), { code: "EBUSY" }); }, "rejects");
  d.add(() => { throw secret; }, "throws-string");
  d.add(() => void ran.push("z"), "z");
  const r = await d.dispose();
  assert.deepEqual(ran, ["z", "a"]);
  assert.equal(r.disposed, 2);
  assert.deepEqual(r.failures, [
    { label: "throws-string", error: { name: "NonError" } },
    { label: "rejects", error: { name: "Error", errno: "EBUSY" } },
    { label: "throws", error: { name: "AxisError", code: "E_UNAVAILABLE" } },
  ]);
  assert.ok(!JSON.stringify(r).includes(secret));
});

test("a hostile thrown value (getter, Proxy) is summarised without running code", async () => {
  const d = new Disposables();
  let ran = 0;
  d.add(() => { throw Object.defineProperty({}, "code", { get: () => (ran++, "ENOENT") }); }, "getter");
  d.add(() => { throw new Proxy({}, { get: () => (ran++, undefined), getPrototypeOf: () => (ran++, null) }); }, "proxy");
  const r = await d.dispose();
  assert.equal(ran, 0);
  assert.deepEqual(r.failures.map((f) => f.error), [{ name: "Error" }, { name: "Error" }]);
});

test("a disposer that never settles is abandoned after the item timeout, and the rest still run", async () => {
  const d = new Disposables({ itemTimeoutMs: 30 });
  const ran: string[] = [];
  d.add(() => void ran.push("early"), "early");
  d.add(() => new Promise<void>(() => undefined), "hangs");
  d.add(() => void ran.push("late"), "late");
  const before = processSnapshot();
  const r = await d.dispose();
  assert.deepEqual(ran, ["late", "early"]);
  assert.deepEqual(r.failures, [{ label: "hangs", error: "timeout" }]);
  assert.deepEqual(processSnapshot(), before, "the timeout timer is cleared");
});

test("an abandoned disposer that rejects later does not become an unhandled rejection", async () => {
  const d = new Disposables({ itemTimeoutMs: 10 });
  const seen: unknown[] = [];
  const onRejection = (e: unknown): void => void seen.push(e);
  process.on("unhandledRejection", onRejection);
  try {
    d.add(async () => { await wait(40); throw new Error("late failure"); }, "slow");
    await d.dispose();
    await wait(80);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  assert.deepEqual(seen, []);
});

test("itemTimeoutMs 0 means the default (5 s), never unbounded; bad options are refused", async (t) => {
  for (const t0 of [-1, 1.5, NaN, 600_001]) assert.throws(() => new Disposables({ itemTimeoutMs: t0 }), AxisError);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const d = new Disposables({ itemTimeoutMs: 0 });
  d.add(() => new Promise<void>(() => undefined), "hangs");
  let result: unknown;
  const run = d.dispose().then((r) => (result = r));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  t.mock.timers.tick(4_999);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(result, undefined, "still waiting just before 5 s");
  t.mock.timers.tick(1);
  await run;
  assert.deepEqual(result, { disposed: 0, failures: [{ label: "hangs", error: "timeout" }] });
});

test("a disposer that calls dispose() does not wait for itself", async () => {
  for (const itemTimeoutMs of [0, 5_000, 200]) {
    const d = new Disposables({ itemTimeoutMs });
    const order: string[] = [];
    let nested: unknown;
    d.add(() => void order.push("first"), "first");
    d.add(async () => {
      nested = await d.dispose();
      await Promise.resolve().then(() => d.dispose());
      await wait(1);
      await d.dispose();
      order.push("shutdown");
    }, "shutdown");
    const started = Date.now();
    const r = await d.dispose();
    assert.ok(Date.now() - started < 150, `stalled ${Date.now() - started} ms (timeout ${itemTimeoutMs})`);
    assert.deepEqual(order, ["shutdown", "first"]);
    assert.deepEqual(nested, { disposed: 0, failures: [] });
    assert.deepEqual(r, { disposed: 2, failures: [] });
  }
});

test("another registry's dispose() from inside a disposer still waits for that registry", async () => {
  const outer = new Disposables();
  const inner = new Disposables();
  const order: string[] = [];
  inner.add(async () => { await wait(10); order.push("inner"); }, "inner");
  outer.add(async () => { await inner.dispose(); order.push("outer"); }, "outer");
  await outer.dispose();
  assert.deepEqual(order, ["inner", "outer"]);
});

test("the unregister handle runs one disposer once and removes it", async () => {
  const d = new Disposables();
  let a = 0;
  let b = 0;
  const unA = d.add(() => void a++, "a");
  d.add(() => void b++, "b");
  await unA();
  await unA();
  assert.equal(a, 1);
  assert.equal(d.size, 1);
  await d.dispose();
  assert.deepEqual([a, b], [1, 1]);
  await unA();
  assert.equal(a, 1, "after dispose the handle does nothing");
});

test("adding after dispose runs the disposer at once and throws", async () => {
  const d = new Disposables();
  await d.dispose();
  let ran = 0;
  assert.throws(() => d.add(() => void ran++, "late"), (e: unknown) => e instanceof AxisError && e.code === "E_INTERNAL");
  await wait(5);
  assert.equal(ran, 1);
  assert.throws(() => d.setTimeout(() => undefined, 1_000), AxisError);
  assert.throws(() => d.setInterval(() => undefined, 1_000), AxisError);
  assert.throws(() => d.listen(new EventEmitter(), "x", () => undefined), AxisError);
  assert.equal(d.size, 0);
});

test("adding while disposing is refused the same way", async () => {
  const d = new Disposables();
  let lateRan = 0;
  let caught: unknown;
  d.add(() => {
    try { d.add(() => void lateRan++, "late"); } catch (e) { caught = e; }
  }, "adder");
  await d.dispose();
  await wait(5);
  assert.ok(caught instanceof AxisError);
  assert.equal(lateRan, 1);
});

test("labels are validated", () => {
  const d = new Disposables();
  for (const bad of ["", "Upper", "has space", "x".repeat(65), "1abc", "a/b"]) assert.throws(() => d.add(() => undefined, bad), AxisError, bad);
  assert.throws(() => d.add("nope" as never), AxisError);
});

test("the registry is bounded", async () => {
  const d = new Disposables();
  let ran = 0;
  for (let i = 0; i < 10_000; i++) d.add(() => void ran++);
  assert.throws(() => d.add(() => void ran++), (e: unknown) => e instanceof AxisError && e.code === "E_BACKPRESSURE");
  await d.dispose();
  await wait(5);
  assert.equal(ran, 10_001);
});

test("timers are unref'ed, fire normally and are cleared on dispose", async () => {
  const before = processSnapshot();
  const d = new Disposables();
  let fired = 0;
  d.setTimeout(() => void fired++, 5);
  d.setInterval(() => void fired++, 5);
  d.setTimeout(() => { throw new Error("never fires"); }, 60_000);
  d.setInterval(() => { throw new Error("never fires"); }, 60_000);
  await wait(40);
  assert.ok(fired >= 2);
  await d.dispose();
  const after = fired;
  await wait(30);
  assert.equal(fired, after, "the interval stopped");
  assert.deepEqual(processSnapshot(), before);
});

test("listeners are removed on dispose and individually", async () => {
  const before = processSnapshot();
  const d = new Disposables();
  const target = new EventEmitter();
  const got: number[] = [];
  const un = d.listen(target, "data", (n: number) => void got.push(n));
  d.listen(target, "data", (n: number) => void got.push(n * 10));
  target.emit("data", 1);
  await un();
  target.emit("data", 2);
  assert.deepEqual(got, [1, 10, 20]);
  const base = process.listenerCount("SIGUSR2");
  const proc = d.listen(process, "SIGUSR2", () => undefined, "sigusr2");
  assert.equal(process.listenerCount("SIGUSR2"), base + 1);
  await d.dispose();
  assert.equal(target.listenerCount("data"), 0);
  assert.equal(process.listenerCount("SIGUSR2"), base);
  await proc();
  assert.deepEqual(processSnapshot(), before);
});

test("child processes and other resources register as plain disposers", async () => {
  const d = new Disposables();
  const closed: string[] = [];
  const fakeChild = { kill: () => void closed.push("child") };
  d.add(() => fakeChild.kill(), "child:cli");
  await d.dispose();
  assert.deepEqual(closed, ["child"]);
});
