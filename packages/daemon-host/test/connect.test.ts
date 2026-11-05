// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Connection } from "@axis/daemon";
import {
  adaptParentPort,
  ChannelMux,
  createConnectLimiter,
  createConnectRouter,
  type Attestation,
  type ParentPortLike,
} from "../src/index.js";
import { memoryChannelPair } from "../testing/memory-channel.js";
import { fakeClock, wait } from "./helpers.js";

const att = (windowId: unknown = "win-1"): Attestation => ({ identity: { windowId: windowId as string }, issuedAt: 1, mac: "m".repeat(43) });

test("limiter: burst of 5, then 10 a minute; windows are independent", () => {
  const clock = fakeClock();
  const l = createConnectLimiter({ clock });
  const take = (w: string): boolean => l.tryAcquire(w);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(() => take("a")), [true, true, true, true, true, false]);
  assert.equal(take("b"), true);
  clock.advance(5_999);
  assert.equal(take("a"), false);
  clock.advance(1);
  assert.equal(take("a"), true, "one token after 6 s");
  assert.equal(take("a"), false);
  clock.advance(10 * 60_000);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(() => take("a")), [true, true, true, true, true, false], "refills to the burst, not beyond");
});

test("limiter: a backwards clock gives no credit", () => {
  let t = 1_000_000;
  const l = createConnectLimiter({ clock: { now: () => t, monotonic: () => t }, burst: 1 });
  assert.equal(l.tryAcquire("a"), true);
  t -= 500_000;
  assert.equal(l.tryAcquire("a"), false);
});

test("limiter: the map is bounded, idle full buckets are evicted, a throttled window is never evicted", () => {
  const clock = fakeClock();
  const l = createConnectLimiter({ clock, maxWindows: 3, burst: 2 });
  assert.equal(l.tryAcquire("hot"), true);
  assert.equal(l.tryAcquire("hot"), true);
  assert.equal(l.tryAcquire("hot"), false);
  assert.equal(l.tryAcquire("w1"), true);
  assert.equal(l.tryAcquire("w2"), true);
  // Full: w1 and w2 are not back to full yet, so a newcomer is refused and "hot" keeps its state.
  assert.equal(l.tryAcquire("w3"), false);
  assert.equal(l.tryAcquire("hot"), false);
  assert.equal(l.size(), 3);
  clock.advance(60_000); // everyone refills; idle buckets can go, the newcomer fits
  assert.equal(l.tryAcquire("w3"), true);
  assert.ok(l.size() <= 3);
});

test("limiter: invalid limits are refused", () => {
  const clock = fakeClock();
  for (const o of [{ burst: 0 }, { connectsPerMinute: 601 }, { maxWindows: 1.5 }]) {
    assert.throws(() => createConnectLimiter({ clock, ...o }), { code: "E_INVALID_ARGUMENT" });
  }
});

test("router over the mux: allowed connects reach accept; over the limit closes silently", async () => {
  const { a, b } = memoryChannelPair();
  const mux = new ChannelMux(a);
  const peer: unknown[] = [];
  b.onMessage((m) => peer.push(m));
  const accepted: Array<[Connection, Attestation]> = [];
  const router = createConnectRouter({
    mux,
    limiter: createConnectLimiter({ clock: fakeClock(), burst: 1 }),
    accept: (c, at) => accepted.push([c, at]),
  });
  router.fromMux({ cid: "conn-0001", attestation: att() });
  router.fromMux({ cid: "conn-0002", attestation: att() });
  router.fromMux({ cid: "conn-0003", attestation: att("win-2") });
  router.fromMux({ attestation: att() });
  await wait(0);
  assert.equal(accepted.length, 2);
  assert.deepEqual(peer, [{ kind: "close", cid: "conn-0002" }], "no hello-rejected, just a close");
  assert.equal(mux.connectionCount, 2);
  mux.dispose();
});

test("router: an accept that throws closes the connection; a bad window id shares one bucket", async () => {
  const { a } = memoryChannelPair();
  const mux = new ChannelMux(a);
  let closed = 0;
  const router = createConnectRouter({
    mux,
    limiter: createConnectLimiter({ clock: fakeClock(), burst: 1 }),
    accept: (c) => {
      c.onClose(() => closed++);
      throw new Error("nope");
    },
  });
  router.fromMux({ cid: "conn-0001", attestation: att(42) });
  router.fromMux({ cid: "conn-0002", attestation: att("has space") });
  await wait(0);
  assert.equal(closed, 1, "the second was rate limited before accept");
  assert.equal(mux.connectionCount, 0);
  mux.dispose();
});

type Ev = { data: unknown; ports?: Array<{ close(): void }> };
function fakeParent() {
  let listener: ((e: Ev) => void) | undefined;
  const posted: unknown[] = [];
  const port: ParentPortLike = {
    on: (_e, l) => void (listener = l as unknown as (e: Ev) => void),
    off: (_e, l) => void (listener === (l as unknown) && (listener = undefined)),
    postMessage: (m) => void posted.push(m),
  };
  return { port, posted, emit: (e: Ev) => listener?.(e), attached: () => listener !== undefined };
}
const fakePort = () => {
  const p = { closed: 0, close() { p.closed++; }, on() { return p; }, postMessage() {}, start() {} };
  return p;
};

test("electron adapter: control messages, one transferred port to the port handler, extra ports closed", () => {
  const parent = fakeParent();
  const ctl = adaptParentPort(parent.port);
  const msgs: unknown[] = [];
  const ports: Array<[unknown, unknown]> = [];
  ctl.channel.onMessage((m) => msgs.push(m));
  ctl.onPort((d, p) => ports.push([d, p]));
  const p1 = fakePort();
  const p2 = fakePort();
  const p3 = fakePort();
  parent.emit({ data: { type: "shutdown" }, ports: [] });
  parent.emit({ data: { type: "shutdown" } });
  parent.emit({ data: { type: "connect" }, ports: [p1] });
  parent.emit({ data: { type: "connect" }, ports: [p2, p3] });
  assert.equal(msgs.length, 2);
  assert.deepEqual(ports, [[{ type: "connect" }, p1]]);
  assert.deepEqual([p1.closed, p2.closed, p3.closed], [0, 1, 1]);
  assert.equal(ctl.stats().multiPortDropped, 1);
  ctl.channel.send({ type: "ready" });
  assert.deepEqual(parent.posted, [{ type: "ready" }]);
});

test("electron adapter: an unclaimed port is closed; dispose removes the listener, fires close once, refuses send", () => {
  const parent = fakeParent();
  const ctl = adaptParentPort(parent.port);
  const p = fakePort();
  parent.emit({ data: {}, ports: [p] });
  assert.equal(p.closed, 1);
  assert.equal(ctl.stats().unclaimedPorts, 1);
  let closes = 0;
  ctl.channel.onClose(() => closes++);
  ctl.dispose();
  ctl.dispose();
  assert.equal(closes, 1);
  assert.equal(parent.attached(), false);
  assert.throws(() => ctl.channel.send({}), { code: "E_UNAVAILABLE" });
  const late = fakePort();
  parent.emit({ data: {}, ports: [late] });
  assert.equal(late.closed, 0, "nothing is listening any more");
});

test("electron adapter: a throwing postMessage becomes E_UNAVAILABLE", () => {
  const parent = fakeParent();
  parent.port.postMessage = () => {
    throw new Error("secret detail");
  };
  const ctl = adaptParentPort(parent.port);
  assert.throws(() => ctl.channel.send({}), (e: Error & { code?: string }) => e.code === "E_UNAVAILABLE" && !e.message.includes("secret"));
  ctl.dispose();
});

test("router over a transferred port: allowed, limited and closed on throw", () => {
  const accepted: Connection[] = [];
  const router = createConnectRouter({ limiter: createConnectLimiter({ clock: fakeClock(), burst: 1 }), accept: (c) => accepted.push(c) });
  const ok = fakePort();
  const over = fakePort();
  router.fromPort({ attestation: att() }, ok);
  router.fromPort({ attestation: att() }, over);
  assert.equal(accepted.length, 1);
  assert.deepEqual([ok.closed, over.closed], [0, 1]);
});
