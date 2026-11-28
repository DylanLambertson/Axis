// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// OS-3h, the daemon entry's side of the acknowledged pty control hand-over (docs/design/own-shell-main-seam.md §3a), over REAL
// transferable MessagePorts. Mutants each test kills: D1 a generation adopted without its acknowledgement; D2 an older or equal
// generation, or a bad shape, adopted; D3 an unconfirmed generation kept past its expiry, or a confirmed one dropped by it; D4 a
// close instruction not dropping the held generation, or not answered; D5 the legacy shape acknowledged or expired.
import assert from "node:assert/strict";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { after, test } from "node:test";
import type { ControlPortLike } from "../src/bindings/pty-control.js";
import { PTY_CONTROL_EXPIRY_MS, runDaemonEntry } from "../src/entry.js";
import { FakeParentPort, FakeProcess, platformName } from "../testing/entry-harness.js";

/** Timers fired by their delay, so the expiry can be run without the entry's own init timeout. */
class DelayTimers {
  readonly #pending = new Map<number, { fn: () => void; ms: number }>();
  #next = 1;
  set = (fn: () => void, ms: number): number => (this.#pending.set(this.#next, { fn, ms }), this.#next++);
  clear = (h: unknown): void => void this.#pending.delete(h as number);
  fireDelay(ms: number): void {
    for (const [id, t] of [...this.#pending]) if (t.ms === ms) (this.#pending.delete(id), t.fn());
  }
}

const rigs: Array<{ dispose(): void }> = [];
after(() => rigs.forEach((r) => r.dispose()));

function electronShaped(port: MessagePort): ControlPortLike {
  const wrapped = new Map<unknown, (data: unknown) => void>();
  return {
    on(event: "message" | "close", listener: (arg: never) => void) {
      if (event === "message") {
        const w = (data: unknown): void => (listener as (e: unknown) => void)({ data, ports: [] });
        wrapped.set(listener, w);
        return port.on("message", w);
      }
      return port.on("close", listener as () => void);
    },
    removeListener(event: "message" | "close", listener: (arg: never) => void) {
      return port.removeListener(event, (event === "message" ? wrapped.get(listener) : listener) as () => void);
    },
    postMessage: (m: unknown) => port.postMessage(m),
    close: () => port.close(),
    start: () => port.start(),
  } as ControlPortLike;
}

function rig() {
  const port = new FakeParentPort();
  const timers = new DelayTimers();
  const h = runDaemonEntry({ timers, initTimeoutMs: 3_600_000, parentPort: port, process: new FakeProcess(), env: { PATH: "/usr/bin" }, cwd: process.cwd(), platform: platformName(), execArgv: [], stderr: () => undefined });
  rigs.push({ dispose: () => (h as { dispose?: () => void }).dispose?.() });
  const notes = (type: string): number[] => port.posted.filter((m) => m["type"] === type).map((m) => m["generation"] as number);
  return { port, timers, notes };
}

function channel() {
  const { port1, port2 } = new MessageChannel();
  let closed = false;
  port1.on("close", () => void (closed = true));
  return { mine: port1, theirs: electronShaped(port2), closed: () => closed };
}
const until = async (f: () => boolean): Promise<void> => {
  for (let i = 0; i < 500 && !f(); i++) await new Promise((r) => setTimeout(r, 2));
};

test("a generation is adopted and acknowledged; confirmed, it survives the expiry", async () => {
  const r = rig();
  const c = channel();
  r.port.deliver({ type: "pty-control", generation: 1 }, [c.theirs as never]);
  await until(() => r.notes("pty-control-adopted").length > 0);
  assert.deepEqual(r.notes("pty-control-adopted"), [1], "D1");
  r.port.deliver({ type: "pty-control-confirmed", generation: 1 });
  r.timers.fireDelay(PTY_CONTROL_EXPIRY_MS);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(c.closed(), false, "D3: confirmed, kept");
  c.mine.close();
});

test("an unconfirmed generation is dropped at its expiry", async () => {
  const r = rig();
  const c = channel();
  r.port.deliver({ type: "pty-control", generation: 2 }, [c.theirs as never]);
  await until(() => r.notes("pty-control-adopted").length > 0);
  r.timers.fireDelay(PTY_CONTROL_EXPIRY_MS);
  await until(() => c.closed());
  assert.equal(c.closed(), true, "D3");
});

test("an older or equal generation and every bad shape is closed, unadopted and unanswered", async () => {
  const r = rig();
  const first = channel();
  r.port.deliver({ type: "pty-control", generation: 5 }, [first.theirs as never]);
  await until(() => r.notes("pty-control-adopted").length > 0);
  const shapes = [{ type: "pty-control", generation: 5 }, { type: "pty-control", generation: 3 }, { type: "pty-control", generation: 0 }, { type: "pty-control", generation: 2.5 }, { type: "pty-control", generation: "7" }, { type: "pty-control", generation: 8, x: 1 }];
  const refused = shapes.map(() => channel());
  shapes.forEach((s, i) => r.port.deliver(s, [refused[i]!.theirs as never]));
  await until(() => refused.every((c) => c.closed()));
  assert.ok(refused.every((c) => c.closed()), "D2: all closed");
  assert.deepEqual(r.notes("pty-control-adopted"), [5], "D2: nothing else acknowledged");
  assert.equal(first.closed(), false, "D2: the held one untouched");
  first.mine.close();
});

test("a close instruction drops the held generation and is always answered", async () => {
  const r = rig();
  const c = channel();
  r.port.deliver({ type: "pty-control", generation: 4 }, [c.theirs as never]);
  await until(() => r.notes("pty-control-adopted").length > 0);
  r.port.deliver({ type: "pty-control-close", generation: 3 });
  await until(() => r.notes("pty-control-closed").length > 0);
  assert.deepEqual(r.notes("pty-control-closed"), [3], "D4: an unknown generation is answered");
  assert.equal(c.closed(), false, "D4: and changes nothing");
  r.port.deliver({ type: "pty-control-close", generation: 4 });
  await until(() => c.closed());
  assert.equal(c.closed(), true, "D4");
  await until(() => r.notes("pty-control-closed").length > 1);
  assert.deepEqual(r.notes("pty-control-closed"), [3, 4]);
});

test("the legacy shape without a generation is adopted, never acknowledged, never expired", async () => {
  const r = rig();
  const c = channel();
  r.port.deliver({ type: "pty-control" }, [c.theirs as never]);
  r.timers.fireDelay(PTY_CONTROL_EXPIRY_MS);
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(r.notes("pty-control-adopted"), [], "D5");
  assert.equal(c.closed(), false, "D5");
  c.mine.close();
});
