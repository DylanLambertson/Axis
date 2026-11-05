// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelMux } from "../src/index.js";
import { memoryChannelPair } from "../testing/memory-channel.js";
import { wait } from "./helpers.js";

const CID = "conn-0001";
const frame = (cid: string, data: unknown): unknown => ({ kind: "frame", cid, data });

function setup(limits: ConstructorParameters<typeof ChannelMux>[1] = {}) {
  const { a, b } = memoryChannelPair();
  const mux = new ChannelMux(a, limits);
  const peerSeen: unknown[] = [];
  b.onMessage((m) => peerSeen.push(m));
  return { a, b, mux, peerSeen };
}

test("frames flow both ways and arrive in order; the reader may attach late", async () => {
  const { b, mux, peerSeen } = setup();
  const conn = mux.open(CID);
  assert.ok(conn);
  b.send(frame(CID, { n: 1 }));
  b.send(frame(CID, { n: 2 }));
  await wait(0);
  const got: unknown[] = [];
  conn.onMessage((m) => got.push(m));
  b.send(frame(CID, { n: 3 }));
  await wait(0);
  assert.deepEqual(got, [{ n: 1 }, { n: 2 }, { n: 3 }]);
  conn.send({ hello: "world" });
  await wait(0);
  assert.deepEqual(peerSeen, [{ kind: "frame", cid: CID, data: { hello: "world" } }]);
});

test("control messages go to control handlers, not to connections, and are size capped", async () => {
  const { b, mux } = setup({ limits: { maxControlBytes: 200 } });
  const seen: unknown[] = [];
  mux.onControl((m) => seen.push(m));
  b.send({ type: "shutdown" });
  b.send({ type: "x", pad: "a".repeat(500) });
  await wait(0);
  assert.deepEqual(seen, [{ type: "shutdown" }]);
  assert.equal(mux.stats().invalidMessages, 1);
  assert.throws(() => mux.sendControl({ pad: "a".repeat(500) }), { code: "E_INVALID_ARGUMENT" });
});

test("frames for unknown or closed cids are ignored and counted", async () => {
  const { b, mux } = setup();
  const conn = mux.open(CID);
  assert.ok(conn);
  b.send(frame("conn-9999", 1));
  b.send({ kind: "close", cid: "conn-9999" });
  b.send({ kind: "close", cid: CID });
  b.send(frame(CID, 2));
  await wait(0);
  assert.equal(mux.stats().unknownFrames, 3);
  assert.equal(mux.connectionCount, 0);
});

test("close is idempotent, fires onClose once, and sends one close frame", async () => {
  const { mux, peerSeen } = setup();
  const conn = mux.open(CID);
  assert.ok(conn);
  let closes = 0;
  conn.onClose(() => closes++);
  conn.close();
  conn.close();
  await wait(0);
  assert.equal(closes, 1);
  assert.deepEqual(peerSeen, [{ kind: "close", cid: CID }]);
  conn.send({ late: true });
  assert.equal(mux.stats().sendsAfterClose, 1);
  let late = 0;
  conn.onClose(() => late++);
  await wait(0);
  assert.equal(late, 1, "a close handler added after close still hears of it");
});

test("a frame over the size cap closes that connection only and is counted", async () => {
  const { b, mux } = setup({ limits: { maxFrameBytes: 1000 } });
  const bad = mux.open(CID);
  const good = mux.open("conn-0002");
  assert.ok(bad && good);
  let closed = false;
  bad.onClose(() => (closed = true));
  const got: unknown[] = [];
  good.onMessage((m) => got.push(m));
  b.send(frame(CID, { pad: "a".repeat(5000) }));
  b.send(frame("conn-0002", { ok: 1 }));
  await wait(0);
  assert.equal(closed, true);
  assert.deepEqual(got, [{ ok: 1 }]);
  assert.equal(mux.stats().oversizeClosed, 1);
  assert.throws(() => good.send({ pad: "a".repeat(5000) }), { code: "E_INVALID_ARGUMENT" });
});

test("hostile shapes: accessors, proxies, shared references and forbidden keys close or are counted", async () => {
  const { a, mux } = setup();
  const conn = mux.open(CID);
  assert.ok(conn);
  let closed = 0;
  conn.onClose(() => closed++);
  const getter = {};
  let reads = 0;
  Object.defineProperty(getter, "x", { enumerable: true, get: () => (reads++, 1) });
  a.inject({ kind: "frame", cid: "conn-0002", data: getter });
  a.inject(frame(CID, getter));
  a.inject(new Proxy({ kind: "frame", cid: CID, data: 1 }, {}));
  a.inject({ kind: "weird" });
  a.inject([1, 2]);
  a.inject("text");
  a.inject({ get kind() { reads++; return "frame"; }, cid: CID });
  await wait(0);
  assert.equal(reads, 0, "no accessor ran");
  assert.equal(closed, 1, "the accessor in data closed the connection");
  assert.equal(mux.stats().invalidMessages, 5);
  assert.equal(mux.stats().unknownFrames, 1);
  const second = mux.open("conn-0002");
  assert.ok(second);
  let closed2 = 0;
  second.onClose(() => closed2++);
  a.inject(frame("conn-0002", JSON.parse('{"__proto__":{"a":1}}')));
  await wait(0);
  assert.equal(closed2, 1);
});

test("queue bounds: too many frames or bytes for a reader that has not attached closes the connection", async () => {
  const { b, mux } = setup({ limits: { maxQueuedMessages: 3, maxQueuedBytes: 100_000 } });
  const conn = mux.open(CID);
  assert.ok(conn);
  let closed = 0;
  conn.onClose(() => closed++);
  for (let i = 0; i < 4; i++) b.send(frame(CID, i));
  await wait(0);
  assert.equal(closed, 1);
  assert.equal(mux.stats().overflowClosed, 1);

  const byBytes = setup({ limits: { maxQueuedMessages: 100, maxQueuedBytes: 300 } });
  const c2 = byBytes.mux.open(CID);
  assert.ok(c2);
  let closed2 = 0;
  c2.onClose(() => closed2++);
  for (let i = 0; i < 3; i++) byBytes.b.send(frame(CID, { pad: "a".repeat(120) }));
  await wait(0);
  assert.equal(closed2, 1);
});

test("a reader that throws closes its connection and no other", async () => {
  const { b, mux } = setup();
  const bad = mux.open(CID);
  const good = mux.open("conn-0002");
  assert.ok(bad && good);
  bad.onMessage(() => {
    throw new Error("boom");
  });
  let goodSeen = 0;
  good.onMessage(() => goodSeen++);
  b.send(frame(CID, 1));
  b.send(frame("conn-0002", 1));
  await wait(0);
  assert.equal(mux.connectionCount, 1);
  assert.equal(goodSeen, 1);
  assert.equal(mux.stats().handlerErrorClosed, 1);
});

test("open refuses bad, duplicate and excess cids; the excess one is told to close", async () => {
  const { mux, peerSeen } = setup({ limits: { maxConnections: 2 } });
  assert.equal(mux.open("short"), undefined);
  assert.ok(mux.open("conn-0001"));
  assert.equal(mux.open("conn-0001"), undefined);
  assert.ok(mux.open("conn-0002"));
  assert.equal(mux.open("conn-0003"), undefined);
  await wait(0);
  assert.deepEqual(peerSeen, [{ kind: "close", cid: "conn-0003" }]);
  assert.equal(mux.stats().refusedOpens, 3);
});

test("the channel closing closes every connection once; dispose removes every listener", async () => {
  const { a, b, mux } = setup();
  const before = a.listeners();
  assert.equal(before, 2);
  const c1 = mux.open(CID);
  assert.ok(c1);
  let closes = 0;
  c1.onClose(() => closes++);
  let channelCloses = 0;
  mux.onChannelClose(() => channelCloses++);
  b.close();
  await wait(0);
  assert.equal(closes, 1);
  assert.equal(channelCloses, 1);
  assert.throws(() => mux.sendControl({ type: "x" }), { code: "E_UNAVAILABLE" });
  assert.equal(mux.open("conn-0002"), undefined);
  mux.dispose();
  mux.dispose();
  assert.equal(a.listeners(), 0);

  const second = setup();
  const c = second.mux.open(CID);
  assert.ok(c);
  second.mux.dispose();
  await wait(0);
  assert.equal(second.a.listeners(), 0);
  assert.equal(second.mux.connectionCount, 0);
});

test("invalid limits are refused at construction", () => {
  const { a } = memoryChannelPair();
  assert.throws(() => new ChannelMux(a, { limits: { maxConnections: 0 } }), { code: "E_INVALID_ARGUMENT" });
});
