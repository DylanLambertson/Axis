// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventHub, type Identity, type OutboundFrame } from "../src/index.js";
import { assertWireFrames, ereq, eventsRig, eventually, frames, framesOf, isFrame, settle } from "./events-rig.js";

const ws = (id: string) => ({ topic: "workspaces", workspaceId: id });

test("EV1 ordering: the subscribe reply precedes every frame of its subscription (replayed and newly published alike)", async (t) => {
  const hub = new EventHub();
  const r = await eventsRig(t, {}, {}, hub, (h) => ({
    ...h,
    // An event published inside the call, after the subscription exists and before the reply is sent.
    subscribe: (ctx, p) => {
      const out = h.subscribe(ctx, p);
      hub.publish(ws("early"));
      return out;
    },
  }));
  hub.publish(ws("before")); // 1, replayed by the resume below
  const c = { send: r.send, inbox: r.inbox };
  const reply = await r.subscribe(c, "s1", { topics: ["workspaces"], resumeFrom: { epoch: hub.epoch, seq: 0 } });
  assert.equal(reply.ok, true);
  assert.equal(reply.result?.["resumed"], true);
  const sub = reply.result?.["subscriptionId"] as string;
  const got = await frames(r.inbox, sub, 2);
  assert.deepEqual(got.map((f) => [f.seq, f.event?.["workspaceId"]]), [[1, "before"], [2, "early"]]);
  const replyAt = r.inbox.all.findIndex((m) => (m as { id?: string }).id === "s1");
  const frameAt = r.inbox.all.findIndex(isFrame);
  assert.ok(replyAt >= 0 && replyAt < frameAt, "the reply is on the wire before the first frame");
  assert.equal(reply.result?.["seq"], 1, "the head when the subscription was made");
});

test("EV2 frames are in seq order, coalesced by key, and paced by the credit window", async (t) => {
  const r = await eventsRig(t, { window: 1 });
  const c = { send: r.send, inbox: r.inbox };
  const sub = (await r.subscribe(c, "s1", { topics: ["workspaces"] })).result?.["subscriptionId"] as string;
  r.hub.publish(ws("a")); // 1: sent at once
  r.hub.publish(ws("b")); // 2: queued
  r.hub.publish(ws("a")); // 3: queued
  r.hub.publish(ws("b")); // 4: replaces 2 and moves behind 3
  await settle(c, "x1");
  assert.deepEqual(framesOf(r.inbox, sub).map((f) => f.seq), [1], "one frame while unacknowledged");
  r.send({ v: 1, ack: sub, seq: 1 });
  await frames(r.inbox, sub, 2);
  r.send({ v: 1, ack: sub, seq: 3 });
  const all = await frames(r.inbox, sub, 3);
  await settle(c, "x2");
  assert.deepEqual(all.map((f) => [f.seq, f.event?.["workspaceId"]]), [[1, "a"], [3, "a"], [4, "b"]]);
  assertWireFrames(r.inbox);
});

test("EV3 resume: same epoch and retained seq replays the missed events; another epoch, a pruned or a future seq answers resumed:false", async (t) => {
  const r = await eventsRig(t, { ringSize: 3 });
  const c = { send: r.send, inbox: r.inbox };
  const first = (await r.subscribe(c, "s1", { topics: ["workspaces", "runs"] })).result as { epoch: string; subscriptionId: string };
  r.hub.publish(ws("a")); // 1
  r.hub.publish({ topic: "runs", runId: "r1", state: "RUNNING" }); // 2
  r.hub.publish(ws("b")); // 3
  const d = await r.open("good#conn-2");
  const again = await r.subscribe(d, "s2", { topics: ["workspaces"], resumeFrom: { epoch: first.epoch, seq: 1 } });
  assert.equal(again.result?.["resumed"], true);
  const replay = await frames(d.inbox, again.result?.["subscriptionId"] as string, 1);
  await settle(d, "x1");
  assert.deepEqual(framesOf(d.inbox, again.result?.["subscriptionId"] as string).map((f) => f.seq), [3], "only the matching events after seq 1");
  assert.equal(replay[0]?.event?.["workspaceId"], "b");

  const otherEpoch = await r.subscribe(d, "s3", { topics: ["workspaces"], resumeFrom: { epoch: "B".repeat(22), seq: 1 } });
  assert.equal(otherEpoch.result?.["resumed"], false);
  r.hub.publish(ws("c")); // 4: the ring (3) now starts at 2
  const pruned = await r.subscribe(d, "s4", { topics: ["workspaces"], resumeFrom: { epoch: first.epoch, seq: 0 } });
  assert.equal(pruned.result?.["resumed"], false, "event 1 is gone: resuming from 0 would hide a loss");
  const edge = await r.subscribe(d, "s5", { topics: ["workspaces"], resumeFrom: { epoch: first.epoch, seq: 1 } });
  assert.equal(edge.result?.["resumed"], true, "everything after 1 is still retained");
  const future = await r.open("good#conn-3");
  const ahead = await r.subscribe(future, "s6", { topics: ["workspaces"], resumeFrom: { epoch: first.epoch, seq: 99 } });
  assert.equal(ahead.result?.["resumed"], false);
  await settle(future, "x2");
  assert.equal(framesOf(future.inbox).length, 0, "nothing replayed for a refused resume");
});

test("EV4 slow subscriber: the queue is bounded, an overflow drops to one resync, and publish never blocks", async (t) => {
  const r = await eventsRig(t, { window: 2, queueMax: 3 });
  const c = { send: r.send, inbox: r.inbox };
  const sub = (await r.subscribe(c, "s1", { topics: ["workspaces"] })).result?.["subscriptionId"] as string;
  for (let i = 0; i < 10; i++) assert.equal(r.hub.publish(ws(`w${i}`)), true);
  await settle(c, "x1");
  assert.deepEqual(framesOf(r.inbox, sub).map((f) => f.seq), [1, 2], "the window holds; nothing else is sent unacknowledged");
  assert.ok(r.hub.dropped >= 5, "the drop is counted");
  r.send({ v: 1, ack: sub, seq: 2 });
  const after = await frames(r.inbox, sub, 3);
  assert.deepEqual(after[2]?.resync, { reason: "overflow" });
  assert.equal(after[2]?.seq, 10, "the resync carries the head");
  await settle(c, "x2");
  assert.equal(framesOf(r.inbox, sub).length, 3, "the dropped events are not sent after the resync");
  r.hub.publish(ws("next"));
  const resumed = await frames(r.inbox, sub, 4);
  assert.equal(resumed[3]?.event?.["workspaceId"], "next", "events flow again after the resync");
});

test("EV5 subscription caps: per connection and per daemon, freed by unsubscribe and by a closed connection", async (t) => {
  const r = await eventsRig(t, { maxPerConnection: 2, maxTotal: 3 });
  const c = { send: r.send, inbox: r.inbox };
  const a = await r.subscribe(c, "s1", { topics: ["runs"] });
  await r.subscribe(c, "s2", { topics: ["runs"] });
  assert.equal((await r.subscribe(c, "s3", { topics: ["runs"] })).error?.code, "E_BACKPRESSURE");
  c.send(ereq("u1", "unsubscribe", { subscriptionId: a.result?.["subscriptionId"] }));
  assert.equal((await c.inbox.response("u1")).ok, true);
  assert.equal((await r.subscribe(c, "s4", { topics: ["runs"] })).ok, true);
  const d = await r.open("good#conn-2");
  assert.equal((await r.subscribe(d, "s5", { topics: ["runs"] })).ok, true);
  assert.equal((await r.subscribe(d, "s6", { topics: ["runs"] })).error?.code, "E_BACKPRESSURE", "the daemon-wide cap");
  assert.equal(r.hub.subscriptionCount, 3);
  r.client.close();
  await r.inbox.closedWithin();
  await eventually(() => r.hub.subscriptionCount === 1);
  assert.equal((await r.subscribe(d, "s7", { topics: ["runs"] })).ok, true, "a closed connection frees its subscriptions");
});

test("EV6 authorisation: topics are the subscription's own, approvals reach only their window, ids of another connection are not found, agents cannot subscribe", async (t) => {
  const r = await eventsRig(t);
  const a = await r.open("good#conn-a~win-a");
  const b = await r.open("good#conn-b~win-b");
  const subA = (await r.subscribe(a, "s1", { topics: ["approvals"] })).result?.["subscriptionId"] as string;
  const subB = (await r.subscribe(b, "s2", { topics: ["approvals", "runs"] })).result?.["subscriptionId"] as string;
  assert.equal(r.hub.publish({ topic: "approvals" }), false, "an approvals event without a window is refused");
  r.hub.publish({ topic: "approvals" }, { windowId: "win-a" });
  r.hub.publish(ws("w1"));
  await settle(a, "x1");
  await settle(b, "x2");
  assert.deepEqual(framesOf(a.inbox, subA).map((f) => f.event), [{ topic: "approvals" }]);
  assert.deepEqual(framesOf(b.inbox, subB), [], "window b sees neither window a's approvals nor an unsubscribed topic");
  assert.deepEqual([...r.hub.windowsFor("approvals")].sort(), ["win-a", "win-b"]);

  b.send(ereq("u1", "unsubscribe", { subscriptionId: subA }));
  assert.equal((await b.inbox.response("u1")).error?.code, "E_NOT_FOUND");
  r.hub.publish({ topic: "approvals" }, { windowId: "win-a" });
  await frames(a.inbox, subA, 2); // still live

  // The harness verifier mints user identities only, so the agent case calls the handler directly.
  const ctx = { identity: { connectionId: "conn-agent".padEnd(22, "_"), windowId: "w", actorId: "x", actor: "agent:r1", trusted: true, clientKind: "desktop" } as Identity, requestId: "q", correlationId: "c", signal: new AbortController().signal };
  assert.throws(() => (r.hub.handlers().subscribe as (c: unknown, p: unknown) => unknown)(ctx, { topics: ["runs"] }), (e: Error & { code?: string }) => e.code === "E_NOT_FOUND");
});

test("EV7 no secret or path on the wire: bodies outside the closed schema are refused, and the session re-checks every frame", async (t) => {
  let leak: ((f: OutboundFrame) => void) | undefined;
  class TapHub extends EventHub {
    override attach(identity: Identity, send: (f: OutboundFrame) => void) {
      leak = send;
      return super.attach(identity, send);
    }
  }
  const r = await eventsRig(t, {}, {}, new TapHub());
  const c = { send: r.send, inbox: r.inbox };
  const sub = (await r.subscribe(c, "s1", { topics: ["workspaces", "runs"] })).result?.["subscriptionId"] as string;
  const canary = "/home/someone/secret-project";
  assert.equal(r.hub.publish({ topic: "workspaces", workspaceId: "w1", path: canary }), false);
  assert.equal(r.hub.publish({ topic: "workspaces", workspaceId: canary }), false);
  assert.equal(r.hub.publish({ topic: "runs", runId: "r1", state: "RUNNING", message: canary }), false);
  assert.equal(r.hub.publish({ topic: "nope" }), false);
  assert.equal(r.hub.refused, 4);
  leak?.({ sub, seq: 9, event: { topic: "workspaces", workspaceId: "w1", path: canary } as never });
  await settle(c, "x1");
  assert.equal(framesOf(r.inbox).length, 0);
  assert.ok(!JSON.stringify(r.inbox.all).includes("secret-project"));
  assert.ok(r.internal.length >= 1, "the refused frame is reported locally");
});

test("EV8 shutdown drains subscriptions: end frames before in-flight requests are cancelled, nothing published or subscribed after", async (t) => {
  const r = await eventsRig(t, {}, { shutdown: { graceMs: 30, cancelSettleMs: 30, flushTimeoutMs: 30 } });
  const c = { send: r.send, inbox: r.inbox };
  const d = await r.open("good#conn-2");
  const sub = (await r.subscribe(c, "s1", { topics: ["anchor"] })).result?.["subscriptionId"] as string;
  const sub2 = (await r.subscribe(d, "s2", { topics: ["runs"] })).result?.["subscriptionId"] as string;
  let started = false;
  r.daemon.register("axis.test", 1, { echo: (ctx) => ((started = true), new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve({ text: "x" }), { once: true }))) });
  c.send({ v: 1, id: "hang", contract: "axis.test", contractVersion: 1, method: "echo", payload: { text: "x" } });
  await eventually(() => started);
  const done = r.daemon.shutdown("test");
  const ends = await frames(r.inbox, sub, 1);
  assert.deepEqual(ends[0], { v: 1, sub, end: { reason: "shutdown" } });
  assert.deepEqual((await frames(d.inbox, sub2, 1))[0]?.end, { reason: "shutdown" });
  assert.equal(r.hub.subscriptionCount, 0);
  assert.equal(r.hub.publish({ topic: "anchor", stalled: true }), false);
  await done;
  const hang = await r.inbox.response("hang");
  assert.equal(hang.error?.code, "E_CANCELLED");
  const endAt = r.inbox.all.findIndex(isFrame);
  assert.ok(endAt < r.inbox.all.indexOf(hang), "subscriptions end before in-flight requests are cancelled");
  assert.equal(framesOf(r.inbox, sub).length, 1, "nothing after the end frame");
  const ctx = { identity: { connectionId: "conn-1".padEnd(22, "_"), windowId: "win-1", actorId: "a", actor: "user", trusted: true, clientKind: "desktop" } as Identity, requestId: "late", correlationId: "c", signal: new AbortController().signal };
  assert.throws(() => (r.hub.handlers().subscribe as (c: unknown, p: unknown) => unknown)(ctx, { topics: ["runs"] }), (e: Error & { code?: string }) => e.code === "E_UNAVAILABLE");
  assert.equal(r.hub.ended, true);
});
