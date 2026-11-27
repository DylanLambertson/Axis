// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// `WindowLifetimes` (PV-K2 K2-g4a, plugin-grant-contract.md section 8.4): the epoch rules of a host window, from the daemon's
// per-session lifecycle hook and main's `window.gone`.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Identity } from "@axis/daemon";
import { createWindowLifetimes } from "../src/plugins/window-lifetimes.js";

/** Distinct 16-byte draws (a counter), or the scripted ones first. */
function counter(scripted: number[] = []): { bytes: (n: number) => Uint8Array; calls: number[] } {
  let n = 0;
  const calls: number[] = [];
  return {
    calls,
    bytes: (size) => {
      calls.push(size);
      const seed = scripted.length > 0 ? (scripted.shift() as number) : 1000 + n++;
      const out = new Uint8Array(size);
      out[0] = seed & 0xff;
      out[1] = (seed >> 8) & 0xff;
      return out;
    },
  };
}

const desktop = (connection: string, windowId = "w1"): Identity => ({
  connectionId: connection.padEnd(22, "_"),
  windowId,
  actorId: "actor-1",
  actor: "user",
  trusted: false,
  clientKind: "desktop",
});

test("two connections to one window share one epoch; it ends only at the last close", () => {
  const w = createWindowLifetimes({ randomBytes: counter().bytes });
  const a = desktop("a");
  const b = desktop("b");
  assert.equal(w.current("w1"), undefined);
  w.accepted(a);
  const epoch = w.current("w1");
  assert.ok(epoch !== undefined);
  w.accepted(b);
  assert.equal(w.current("w1"), epoch, "a second connection raises the count, not the epoch");
  w.closed(a);
  assert.equal(w.alive("w1", epoch), true, "one of two closed: still alive");
  w.closed(b);
  assert.equal(w.alive("w1", epoch), false);
  assert.equal(w.status("w1", epoch), "ended");
  assert.equal(w.current("w1"), undefined);
});

test("one, none, one: a new epoch, and the old one stays ended", () => {
  const w = createWindowLifetimes({ randomBytes: counter().bytes });
  w.accepted(desktop("a"));
  const first = w.current("w1") as string;
  w.closed(desktop("a"));
  w.accepted(desktop("b"));
  const second = w.current("w1") as string;
  assert.notEqual(second, first);
  assert.equal(w.status("w1", first), "ended");
  assert.equal(w.status("w1", second), "alive");
  assert.equal(w.alive("w1", first), false, "a reopened window does not revive the old epoch");
  assert.equal(w.alive("w1", second), true);
});

test("a close reported twice is counted once", () => {
  const w = createWindowLifetimes({ randomBytes: counter().bytes });
  w.accepted(desktop("a"));
  w.accepted(desktop("b"));
  const epoch = w.current("w1") as string;
  w.closed(desktop("a"));
  w.closed(desktop("a"));
  assert.equal(w.alive("w1", epoch), true, "b is still attached");
  w.closed(desktop("b"));
  assert.equal(w.alive("w1", epoch), false);
});

test("a close for a connection never accepted (a rejected handshake calls no hook) changes nothing", () => {
  const w = createWindowLifetimes({ randomBytes: counter().bytes });
  w.closed(desktop("ghost"));
  assert.equal(w.current("w1"), undefined);
  w.accepted(desktop("a"));
  const epoch = w.current("w1") as string;
  w.closed(desktop("ghost"));
  assert.equal(w.alive("w1", epoch), true);
});

test("the same connection accepted twice counts once", () => {
  const w = createWindowLifetimes({ randomBytes: counter().bytes });
  w.accepted(desktop("a"));
  w.accepted(desktop("a"));
  const epoch = w.current("w1") as string;
  w.closed(desktop("a"));
  assert.equal(w.alive("w1", epoch), false);
});

test("window.gone ends the epoch while a connection's close was never reported; that late close touches no later epoch", () => {
  const w = createWindowLifetimes({ randomBytes: counter().bytes });
  w.accepted(desktop("stale"));
  const first = w.current("w1") as string;
  w.gone("w1");
  assert.equal(w.status("w1", first), "ended");
  assert.equal(w.current("w1"), undefined);
  w.accepted(desktop("fresh"));
  const second = w.current("w1") as string;
  assert.notEqual(second, first);
  w.closed(desktop("stale"));
  assert.equal(w.alive("w1", second), true, "the stale connection belonged to the ended epoch");
  w.gone("w1");
  w.gone("w1");
  w.gone("w9");
  assert.equal(w.status("w1", second), "ended");
});

test("only desktop sessions count; other windows are independent", () => {
  const w = createWindowLifetimes({ randomBytes: counter().bytes });
  w.accepted({ ...desktop("p"), clientKind: "plugin", windowId: "p1", actor: "plugin:x", actorId: "plugin:x", hostWindowId: "w1", workspaceId: "proj" });
  w.accepted({ ...desktop("web"), clientKind: "web" });
  assert.equal(w.current("w1"), undefined);
  assert.equal(w.current("p1"), undefined);
  w.accepted(desktop("a", "w1"));
  w.accepted(desktop("b", "w2"));
  const one = w.current("w1") as string;
  w.closed(desktop("b", "w2"));
  assert.equal(w.alive("w1", one), true);
  assert.equal(w.current("w2"), undefined);
  assert.equal(w.status("w2", one), "unknown", "an epoch is bound to its window");
});

test("an epoch is 16 random bytes in base64url, never reused: a repeated draw is drawn again", () => {
  const random = counter([7, 7, 7, 8]);
  const w = createWindowLifetimes({ randomBytes: random.bytes });
  w.accepted(desktop("a", "w1"));
  const first = w.current("w1") as string;
  assert.match(first, /^[A-Za-z0-9_-]{22}$/);
  w.accepted(desktop("b", "w2")); // draws 7 (taken by w1), then 7 again, then 8
  const second = w.current("w2") as string;
  assert.notEqual(second, first);
  w.closed(desktop("a", "w1"));
  w.accepted(desktop("c", "w1")); // the next counter draw; 7 is ended, never handed out again
  assert.notEqual(w.current("w1"), first);
  assert.ok(random.calls.every((n) => n === 16));
});

test("a draw that never comes out fresh fails closed: no epoch, so nothing is alive", () => {
  const w = createWindowLifetimes({ randomBytes: () => new Uint8Array(16) });
  w.accepted(desktop("a", "w1"));
  const first = w.current("w1") as string;
  w.closed(desktop("a", "w1"));
  assert.throws(() => w.accepted(desktop("b", "w1")), /epoch/);
  assert.equal(w.current("w1"), undefined);
  assert.equal(w.status("w1", first), "ended");
  w.closed(desktop("b", "w1"));
  assert.equal(w.current("w1"), undefined);
});

test("a short random draw is refused", () => {
  const w = createWindowLifetimes({ randomBytes: () => new Uint8Array(8) });
  assert.throws(() => w.accepted(desktop("a")), /epoch/);
  assert.equal(w.current("w1"), undefined);
});

test("ended epochs are remembered in a bounded ring: the oldest falls back to unknown, never to alive", () => {
  const w = createWindowLifetimes({ randomBytes: counter().bytes, endedRing: 2 });
  const ended: string[] = [];
  for (const c of ["a", "b", "c"]) {
    w.accepted(desktop(c));
    ended.push(w.current("w1") as string);
    w.closed(desktop(c));
  }
  assert.deepEqual(ended.map((e) => w.status("w1", e)), ["unknown", "ended", "ended"]);
  assert.equal(w.alive("w1", ended[0] as string), false);
  assert.equal(w.status("w1", "never-issued"), "unknown");
});

test("the ring size must be a positive integer (review K2-g4a N1)", () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "2"]) {
    assert.throws(() => createWindowLifetimes({ randomBytes: counter().bytes, endedRing: bad as never }), /endedRing/, String(bad));
  }
  const one = createWindowLifetimes({ randomBytes: counter().bytes, endedRing: 1 });
  one.accepted(desktop("a"));
  const e = one.current("w1") as string;
  one.closed(desktop("a"));
  assert.equal(one.status("w1", e), "ended");
});
