// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { adaptNodeIpc, type IpcLike } from "../src/index.js";

/** A fake IPC end whose writes complete when the test says so. */
function fakeIpc(): IpcLike & { callbacks: Array<(e: Error | null) => void>; throwNext: boolean } {
  const ee = new EventEmitter();
  const fake = {
    connected: true,
    callbacks: [] as Array<(e: Error | null) => void>,
    throwNext: false,
    send(_m: unknown, cb?: (e: Error | null) => void): boolean {
      if (fake.throwNext) throw new Error("gone");
      if (cb !== undefined) fake.callbacks.push(cb);
      return true;
    },
    on: (event: string, l: (...a: unknown[]) => void) => ee.on(event, l),
    off: (event: string, l: (...a: unknown[]) => void) => ee.off(event, l),
  };
  return fake as unknown as IpcLike & { callbacks: Array<(e: Error | null) => void>; throwNext: boolean };
}

test("node ipc: pending counts sends until their write callback runs, and drain fires at zero", () => {
  const proc = fakeIpc();
  const ch = adaptNodeIpc(proc);
  let drains = 0;
  const off = ch.onDrain(() => void drains++);
  ch.send({ a: 1 });
  ch.send({ a: 2 });
  assert.equal(ch.pending(), 2);
  proc.callbacks[0]?.(null);
  assert.equal(ch.pending(), 1);
  assert.equal(drains, 0);
  proc.callbacks[0]?.(null);
  proc.callbacks[1]?.(new Error("closed"));
  assert.equal(ch.pending(), 0, "an errored write counts as done, a repeated callback is ignored");
  assert.equal(drains, 1);
  off();
  ch.send({ a: 3 });
  proc.callbacks[2]?.(null);
  assert.equal(drains, 1, "an unsubscribed handler is not called");
  ch.dispose();
});

test("node ipc: a send that throws is not left pending", () => {
  const proc = fakeIpc();
  const ch = adaptNodeIpc(proc);
  proc.throwNext = true;
  assert.throws(() => ch.send({ a: 1 }));
  assert.equal(ch.pending(), 0);
  ch.dispose();
});
