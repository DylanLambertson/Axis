// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-X1b (docs/design/pty-exec-node.md §6.4): main's pty process supervisor and the shutdown order, with a manual clock.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PTY_POLICY, PtySupervisor, shutdownInOrder, type PtyChild, type PtySupervisorEvent } from "../src/main/pty-supervisor.js";
import { DEFAULT_RESTART_POLICY, type SupervisorTimers } from "../src/supervisor.js";

class FakeChild implements PtyChild {
  readonly signals: string[] = [];
  #exit: ((code: number | null) => void) | undefined;
  kill(signal: "SIGTERM" | "SIGKILL"): void {
    this.signals.push(signal);
  }
  onExit(handler: (code: number | null) => void): () => void {
    this.#exit = handler;
    return () => {
      this.#exit = undefined;
    };
  }
  exit(code: number | null): void {
    this.#exit?.(code);
  }
}

class Clock implements SupervisorTimers {
  now = 0;
  #next = 1;
  readonly pending = new Map<number, { at: number; fn: () => void }>();
  set(fn: () => void, ms: number): unknown {
    const id = this.#next++;
    this.pending.set(id, { at: this.now + ms, fn });
    return id;
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.pending].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= this.now && this.pending.delete(id)) t.fn();
    }
  }
}

function rig(policy: Partial<typeof DEFAULT_PTY_POLICY> = {}) {
  const clock = new Clock();
  const children: FakeChild[] = [];
  const events: string[] = [];
  const lives: string[] = [];
  const sup = new PtySupervisor({
    spawn: () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    },
    timers: clock,
    now: () => clock.now,
    policy,
    onEvent: (e: PtySupervisorEvent, f) => events.push(`${e}${f.code === undefined ? "" : `:${f.code}`}${f.reason === undefined ? "" : `:${f.reason}`}${f.count === undefined ? "" : `#${f.count}`}`),
    onChild: (c, alive) => lives.push(`${children.indexOf(c as FakeChild)}:${alive ? "up" : "down"}`),
  });
  return { clock, children, events, lives, sup };
}

test("the pty policy is the daemon's restart policy with its own stop grace", () => {
  for (const k of ["maxRestarts", "windowMs", "baseDelayMs", "maxDelayMs", "stableMs"] as const) assert.equal(DEFAULT_PTY_POLICY[k], DEFAULT_RESTART_POLICY[k], k);
  assert.ok(DEFAULT_PTY_POLICY.stopGraceMs > 0 && DEFAULT_PTY_POLICY.stopGraceMs <= DEFAULT_RESTART_POLICY.stopGraceMs);
});

test("a crash restarts with exponential backoff; each child is reported up and down", () => {
  const { clock, children, events, lives, sup } = rig();
  sup.start();
  sup.start();
  assert.equal(children.length, 1, "start is idempotent");
  children[0]!.exit(1);
  assert.equal(sup.state(), "backoff");
  clock.advance(999);
  assert.equal(children.length, 1);
  clock.advance(1);
  assert.equal(children.length, 2, "restarted after baseDelayMs");
  children[1]!.exit(null);
  clock.advance(1999);
  assert.equal(children.length, 2);
  clock.advance(1);
  assert.equal(children.length, 3, "second delay doubles");
  assert.deepEqual(events, ["spawned", "exited:1", "restart_scheduled:1#1", "spawned", "exited:null", "restart_scheduled:null#2", "spawned"]);
  assert.deepEqual(lives, ["0:up", "0:down", "1:up", "1:down", "2:up"]);
});

test("exit 78 (a refused hand-over) is failed with bad_config and never restarted", () => {
  const { clock, children, sup } = rig();
  sup.start();
  children[0]!.exit(78);
  clock.advance(10 * 60_000);
  assert.equal(sup.state(), "failed");
  assert.equal(sup.failure(), "bad_config");
  assert.equal(children.length, 1);
});

test("more than maxRestarts crashes in the window is crash_loop; a stable run forgets earlier crashes", () => {
  const { clock, children, sup } = rig({ maxRestarts: 2, baseDelayMs: 10, maxDelayMs: 10, stableMs: 1000 });
  sup.start();
  children[0]!.exit(1);
  clock.advance(10);
  clock.advance(5000); // the second run was stable
  children[1]!.exit(1);
  clock.advance(10);
  children[2]!.exit(1);
  clock.advance(10);
  assert.equal(sup.state(), "running", "the stable run reset the count: two quick crashes are allowed");
  children[3]!.exit(1);
  assert.equal(sup.state(), "failed");
  assert.equal(sup.failure(), "crash_loop");
  clock.advance(1000);
  assert.equal(children.length, 4);
});

test("a spawn that throws is failed with spawn_failed", () => {
  const clock = new Clock();
  const sup = new PtySupervisor({ spawn: () => { throw new Error("no entry"); }, timers: clock, now: () => clock.now });
  sup.start();
  assert.deepEqual([sup.state(), sup.failure()], ["failed", "spawn_failed"]);
});

test("shutdown: SIGTERM, then SIGKILL after the grace when the child does not exit; the stop resolves either way", async () => {
  const { clock, children, sup } = rig({ stopGraceMs: 500 });
  sup.start();
  let done = false;
  const stopped = sup.shutdown().then(() => {
    done = true;
  });
  assert.deepEqual(children[0]!.signals, ["SIGTERM"]);
  clock.advance(499);
  await Promise.resolve();
  assert.equal(done, false);
  clock.advance(1);
  await stopped;
  assert.deepEqual(children[0]!.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(sup.state(), "stopped");
  children[0]!.exit(null);
  clock.advance(60_000);
  assert.equal(children.length, 1, "a late exit after the stop never restarts");
});

test("shutdown: a child that exits on SIGTERM is not killed again; a pending restart is cancelled", async () => {
  const { clock, children, sup } = rig();
  sup.start();
  const stopped = sup.shutdown();
  children[0]!.exit(0);
  await stopped;
  assert.deepEqual(children[0]!.signals, ["SIGTERM"]);
  assert.equal(clock.pending.size, 0);

  const second = rig();
  second.sup.start();
  second.children[0]!.exit(1);
  assert.equal(second.sup.state(), "backoff");
  await second.sup.shutdown();
  second.clock.advance(60_000);
  assert.equal(second.children.length, 1, "no restart after shutdown");
  assert.equal(second.sup.state(), "stopped");
});

test("shutdown order: the daemon first, then the pty process; a daemon that never stops cannot keep the pty process alive", async () => {
  const order: string[] = [];
  const { clock, children, sup } = rig({ stopGraceMs: 100 });
  sup.start();
  const hung = new Promise<void>(() => {
    order.push("daemon stop asked");
  });
  const all = shutdownInOrder(() => hung, sup, clock, 1000);
  assert.deepEqual(children[0]!.signals, [], "the pty process is not touched while the daemon may still stop");
  clock.advance(999);
  await Promise.resolve();
  assert.deepEqual(children[0]!.signals, []);
  clock.advance(1);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(children[0]!.signals, ["SIGTERM"], "the bound ran out: the pty stop starts");
  clock.advance(100);
  await all;
  assert.deepEqual(children[0]!.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(order, ["daemon stop asked"]);

  const quick = rig();
  quick.sup.start();
  let daemonDone = false;
  const both = shutdownInOrder(async () => { daemonDone = true; }, quick.sup, quick.clock, 1000);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.ok(daemonDone);
  assert.deepEqual(quick.children[0]!.signals, ["SIGTERM"], "a daemon that stops at once does not wait for the bound");
  quick.children[0]!.exit(0);
  await both;
  assert.equal(quick.clock.pending.size, 0, "the bound timer is cleared");
});
