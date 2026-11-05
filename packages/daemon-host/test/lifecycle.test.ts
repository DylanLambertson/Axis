// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Redactor } from "@axis/audit";
import type { ShutdownResult } from "@axis/daemon";
import { createLogger, EXIT, exitCodeForShutdown, installHostLifecycle, type DisposeResult, type ExitInfo, type LifecycleOptions } from "../src/index.js";
import { fakeClock, trackTimers, wait } from "./helpers.js";

const CLEAN: ShutdownResult = { reason: "t", graceful: true, escalated: false, cancelled: 0, unsettled: 0, flushed: "done" };
const OK_STOP: DisposeResult = { disposed: 1, failures: [] };

function rig(over: { result?: ShutdownResult | Error; shutdownGate?: Promise<void>; opts?: Partial<LifecycleOptions> } = {}) {
  const proc = new EventEmitter();
  const control = new EventEmitter();
  const calls: string[] = [];
  const exits: Array<{ code: number; info: ExitInfo }> = [];
  const lines: string[] = [];
  const logger = createLogger({ redactor: new Redactor(), clock: fakeClock(), sink: { write: (l) => void lines.push(l) } });
  const baseline = { proc: proc.eventNames().length, control: control.eventNames().length };
  const handle = installHostLifecycle({
    daemon: {
      shutdown: async (reason) => {
        calls.push(`shutdown:${reason}`);
        await over.shutdownGate;
        if (over.result instanceof Error) throw over.result;
        return over.result ?? CLEAN;
      },
      escalate: () => void calls.push("escalate"),
    },
    control: { onShutdown: (h) => (control.on("shutdown", h), () => void control.off("shutdown", h)) },
    stop: async () => (calls.push("stop"), OK_STOP),
    logger,
    exit: (code, info) => void exits.push({ code, info }),
    process: proc,
    ...over.opts,
  });
  const listeners = (): number => proc.eventNames().reduce((n, e) => n + proc.listenerCount(e), 0) + control.listenerCount("shutdown");
  return { proc, control, calls, exits, lines, handle, listeners, baseline };
}

test("SIGTERM: one shutdown, then the store is released, exit 0 and every listener is gone", async () => {
  const r = rig();
  assert.ok(r.listeners() >= 4, "signals, crash handlers and the control message are listened for");
  r.proc.emit("SIGTERM", "SIGTERM");
  await r.handle.finished;
  assert.deepEqual(r.calls, ["shutdown:signal:SIGTERM", "stop"]);
  assert.deepEqual(r.exits.map((e) => [e.code, e.info.released]), [[EXIT.OK, true]]);
  assert.equal(r.listeners(), 0, "nothing left on process or the control channel");
});

test("SIGINT and the Windows control message start the same shutdown", async () => {
  const a = rig();
  a.proc.emit("SIGINT", "SIGINT");
  await a.handle.finished;
  assert.deepEqual(a.calls, ["shutdown:signal:SIGINT", "stop"]);
  const b = rig();
  b.control.emit("shutdown");
  await b.handle.finished;
  assert.deepEqual(b.calls, ["shutdown:control:shutdown", "stop"]);
  assert.equal(b.exits[0]?.code, 0);
});

test("a repeated trigger from either source escalates; it never starts a second shutdown", async () => {
  let open!: () => void;
  const r = rig({ shutdownGate: new Promise<void>((res) => void (open = res)) });
  r.control.emit("shutdown");
  r.proc.emit("SIGTERM", "SIGTERM");
  r.control.emit("shutdown");
  assert.deepEqual(r.calls, ["shutdown:control:shutdown", "escalate", "escalate"]);
  open();
  await r.handle.finished;
  assert.equal(r.calls.filter((c) => c.startsWith("shutdown")).length, 1);
});

test("work still running: the store and the lock stay open, exit 1, the caller is told to force the exit", async () => {
  for (const result of [{ ...CLEAN, graceful: false, unsettled: 2, cancelled: 2 }, { ...CLEAN, flushed: "running" as const }]) {
    const r = rig({ result });
    r.proc.emit("SIGTERM", "SIGTERM");
    await r.handle.finished;
    assert.deepEqual(r.calls, ["shutdown:signal:SIGTERM"], "stop (database handle, lock) must not run");
    assert.deepEqual(r.exits.map((e) => [e.code, e.info.released]), [[EXIT.UNSETTLED, false]]);
    assert.equal(r.exits[0]?.info.result, result);
  }
});

test("exit codes: clean 0; cancelled, unsettled or a failed flush 1; a shutdown that threw 70", async () => {
  assert.equal(exitCodeForShutdown(CLEAN), EXIT.OK);
  assert.equal(exitCodeForShutdown({ ...CLEAN, flushed: "unsupported" }), EXIT.OK);
  assert.equal(exitCodeForShutdown({ ...CLEAN, graceful: false, cancelled: 1 }), EXIT.UNSETTLED);
  assert.equal(exitCodeForShutdown({ ...CLEAN, cancelled: 1 }), EXIT.UNSETTLED);
  assert.equal(exitCodeForShutdown({ ...CLEAN, flushed: "failed" }), EXIT.UNSETTLED);
  assert.equal(exitCodeForShutdown(undefined), EXIT.INTERNAL);
  const r = rig({ result: new Error("boom") });
  r.proc.emit("SIGTERM", "SIGTERM");
  await r.handle.finished;
  assert.deepEqual(r.exits.map((e) => [e.code, e.info.released]), [[EXIT.INTERNAL, false]], "an unknown state is not closed");
  assert.deepEqual(r.calls, ["shutdown:signal:SIGTERM"]);
});

test("a failed or hung stop, or a failing disposer, is reported as exit 1 and never as clean", async () => {
  const bad = rig({ opts: { stop: async () => ({ disposed: 0, failures: [{ label: "x", error: "timeout" }] }) } });
  bad.proc.emit("SIGTERM", "SIGTERM");
  await bad.handle.finished;
  assert.equal(bad.exits[0]?.code, EXIT.UNSETTLED);
  assert.equal(bad.exits[0]?.info.released, false, "an abandoned disposer may still hold the loop: the caller must force the exit");
  const thrown = rig({ opts: { stop: () => Promise.reject(new Error("x")) } });
  thrown.proc.emit("SIGTERM", "SIGTERM");
  await thrown.handle.finished;
  assert.deepEqual(thrown.exits.map((e) => [e.code, e.info.released]), [[EXIT.UNSETTLED, false]]);
});

test("the final checkpoint runs after the drain and before the store is released, bounded, with its timer cleared", async () => {
  const order: string[] = [];
  const ok = rig({ opts: { finalize: () => void order.push("finalize"), stop: async () => (order.push("stop"), OK_STOP) } });
  ok.proc.emit("SIGTERM", "SIGTERM");
  await ok.handle.finished;
  assert.deepEqual(order, ["finalize", "stop"]);
  assert.equal(ok.exits[0]?.code, 0);

  const timers = trackTimers();
  try {
    const hung = rig({ opts: { finalize: () => new Promise<void>(() => undefined), finalizeTimeoutMs: 20 } });
    hung.proc.emit("SIGTERM", "SIGTERM");
    await hung.handle.finished;
    assert.deepEqual(hung.calls, ["shutdown:signal:SIGTERM", "stop"], "a hung anchor put does not stop the release");
    assert.equal(hung.exits[0]?.code, EXIT.UNSETTLED, "an anchor that was not put is reported");
    assert.equal(timers.live(), 0, "the bound timer is cleared");
    const fast = rig({ opts: { finalize: () => undefined } });
    fast.proc.emit("SIGTERM", "SIGTERM");
    await fast.handle.finished;
    assert.equal(timers.live(), 0, "and also when finalize finished first");
  } finally {
    timers.restore();
  }
  const never = rig({ result: { ...CLEAN, unsettled: 1 }, opts: { finalize: () => void order.push("never") } });
  never.proc.emit("SIGTERM", "SIGTERM");
  await never.handle.finished;
  assert.ok(!order.includes("never"), "nothing is written while a handler may still write");
});

test("a crash fails closed: exit 70 at once, no graceful path, no store release, and nothing from the error is logged", async () => {
  const secret = "hunter2-correct-horse";
  for (const event of ["uncaughtException", "unhandledRejection"] as const) {
    const r = rig();
    let read = 0;
    const evil = Object.defineProperty(new Error(`token ${secret}`), "cause", { get: () => (read++, secret) });
    r.proc.emit(event, evil);
    await r.handle.finished;
    assert.deepEqual(r.calls, [], "no drain, no flush, no database write");
    assert.deepEqual(r.exits.map((e) => [e.code, e.info.released, e.info.result]), [[EXIT.INTERNAL, false, undefined]]);
    assert.equal(read, 0, "the thrown value is never read");
    assert.ok(r.lines.some((l) => l.includes('"host.crash"')));
    assert.ok(!r.lines.join("\n").includes(secret), "no error content in the log");
    assert.equal(r.listeners(), 0);
  }
  const r = rig();
  r.proc.emit("unhandledRejection", { then() { throw new Error("x"); } }); // a thenable that throws
  r.proc.emit("uncaughtException", new Error("again"));
  assert.equal(r.exits.length, 1, "a second crash does not call the exit hook again");
});

test("a crash during shutdown wins: the pending shutdown does not release the store or exit again", async () => {
  let open!: () => void;
  const r = rig({ shutdownGate: new Promise<void>((res) => void (open = res)) });
  r.proc.emit("SIGTERM", "SIGTERM");
  r.proc.emit("uncaughtException", new Error("x"));
  open();
  await wait(10);
  assert.deepEqual(r.exits.map((e) => e.code), [EXIT.INTERNAL]);
  assert.deepEqual(r.calls, ["shutdown:signal:SIGTERM"], "stop never ran");
});

test("a failing exit hook is fatal, not swallowed: it rethrows with no listener left to catch it", async () => {
  const r = rig({ opts: { exit: () => { throw new Error("hook"); } } });
  const seen: unknown[] = [];
  const original = process.listeners("uncaughtException");
  process.removeAllListeners("uncaughtException");
  process.once("uncaughtException", (e) => void seen.push(e));
  try {
    r.proc.emit("uncaughtException", new Error("x"));
    await wait(10);
  } finally {
    process.removeAllListeners("uncaughtException");
    for (const l of original) process.on("uncaughtException", l);
  }
  assert.equal(seen.length, 1);
  assert.equal(r.listeners(), 0);
});

test("dispose removes every listener and a later signal does nothing; bad timings are refused", () => {
  const r = rig();
  r.handle.dispose();
  r.handle.dispose();
  assert.equal(r.listeners(), 0);
  r.proc.emit("SIGTERM", "SIGTERM");
  assert.deepEqual(r.calls, []);
  for (const finalizeTimeoutMs of [-1, 1.5, Number.NaN, 10 ** 9]) {
    assert.throws(() => rig({ opts: { finalizeTimeoutMs } }), { code: "E_INVALID_ARGUMENT" });
  }
});

test("a crash during the final checkpoint wins: stop never runs after the crash exit, and the exit is reported once", async () => {
  let crashNow!: () => void;
  let finishFinalize!: () => void;
  const r = rig({
    opts: {
      finalize: () => new Promise<void>((res) => { finishFinalize = res; }),
      finalizeTimeoutMs: 5_000,
    },
  });
  crashNow = () => r.proc.emit("uncaughtException", new Error("x"));
  r.proc.emit("SIGTERM", "SIGTERM");
  await wait(10); // daemon.shutdown resolved, finalize is running
  crashNow();
  finishFinalize();
  await wait(20);
  assert.deepEqual(r.exits.map((e) => [e.code, e.info.released]), [[EXIT.INTERNAL, false]]);
  assert.deepEqual(r.calls, ["shutdown:signal:SIGTERM"], "the database and lock were not closed after the crash");
});

test("a crash while stop is running does not turn into a released exit", async () => {
  let crashNow!: () => void;
  const r = rig({ opts: { stop: async () => { crashNow(); await wait(5); return OK_STOP; } } });
  crashNow = () => r.proc.emit("uncaughtException", new Error("x"));
  r.proc.emit("SIGTERM", "SIGTERM");
  await r.handle.finished;
  await wait(20);
  assert.deepEqual(r.exits.map((e) => [e.code, e.info.released]), [[EXIT.INTERNAL, false]]);
});
