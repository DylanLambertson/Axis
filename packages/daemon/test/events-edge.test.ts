// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventHub, Subscription, coalesceKey, type OutboundFrame } from "../src/index.js";
import { ereq, eventsRig, framesOf, settle } from "./events-rig.js";

const ws = (id: string) => ({ topic: "workspaces", workspaceId: id });

test("EV9 a subscribe whose reply is not a success leaves nothing behind: no subscription, no frame", async (t) => {
  const hub = new EventHub();
  const r = await eventsRig(t, {}, {}, hub, (h) => ({
    ...h,
    subscribe: (ctx, p) => {
      const out = h.subscribe(ctx, p) as Record<string, unknown>;
      if (ctx.requestId === "slow") return new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve(out), { once: true }));
      if (ctx.requestId === "bad") return { ...out, extra: "field" }; // fails the response check: E_INTERNAL
      return out;
    },
  }));
  const c = { send: r.send, inbox: r.inbox };
  c.send(ereq("slow", "subscribe", { topics: ["workspaces"] }, { timeoutMs: 20 }));
  assert.equal((await c.inbox.response("slow")).error?.code, "E_TIMEOUT");
  assert.equal((await r.subscribe(c, "bad", { topics: ["workspaces"] })).error?.code, "E_INTERNAL");
  assert.equal(hub.subscriptionCount, 0, "both subscriptions were dropped with their failed replies");
  hub.publish(ws("w1"));
  await settle(c, "x1");
  assert.equal(framesOf(c.inbox).length, 0);
  const ok = await r.subscribe(c, "good", { topics: ["workspaces"] });
  assert.equal(ok.ok, true, "the connection's cap was not used up by the failed ones");
});

test("EV10 acks: before the handshake an ack closes the connection; an unknown or foreign id grants nothing", async (t) => {
  const r = await eventsRig(t, { window: 1 });
  const early = r.connect("good#conn-early");
  early.client.postMessage({ v: 1, ack: "A".repeat(22), seq: 1 });
  assert.equal(await early.inbox.closedWithin(), true);

  const c = { send: r.send, inbox: r.inbox };
  const d = await r.open("good#conn-2");
  const sub = (await r.subscribe(c, "s1", { topics: ["workspaces"] })).result?.["subscriptionId"] as string;
  r.hub.publish(ws("a"));
  r.hub.publish(ws("b"));
  d.send({ v: 1, ack: sub, seq: 99 }); // another connection's subscription
  c.send({ v: 1, ack: "Z".repeat(22), seq: 99 }); // unknown id
  await settle(d, "x0");
  await settle(c, "x1");
  assert.deepEqual(framesOf(c.inbox, sub).map((f) => f.seq), [1], "still one frame outstanding");
  c.send({ v: 1, ack: sub, seq: 1 });
  await settle(c, "x2");
  assert.deepEqual(framesOf(c.inbox, sub).map((f) => f.seq), [1, 2]);
});

test("EV11 Subscription unit: coalescing keys, nothing before activation, end only for an active subscription", () => {
  assert.equal(coalesceKey({ topic: "workspaces", workspaceId: "a" }), "workspaces:a");
  assert.equal(coalesceKey({ topic: "runs", runId: "a" }), "runs:a");
  assert.equal(coalesceKey({ topic: "anchor", stalled: true }), "anchor");
  const sent: OutboundFrame[] = [];
  const s = new Subscription("S".repeat(22), new Set(["anchor", "audit"]), "w", { window: 4, queueMax: 2 }, (f) => sent.push(f), () => 7);
  s.offer(1, { topic: "anchor", stalled: true });
  s.offer(2, { topic: "anchor", stalled: false });
  s.offer(3, { topic: "audit", headSeq: 5 });
  assert.equal(sent.length, 0, "nothing is sent before activation");
  assert.equal(s.queued, 2, "two keys, the anchor coalesced");
  s.activate();
  assert.deepEqual(sent, [
    { sub: s.id, seq: 2, event: { topic: "anchor", stalled: false } },
    { sub: s.id, seq: 3, event: { topic: "audit", headSeq: 5 } },
  ]);
  s.close("shutdown");
  assert.deepEqual(sent.at(-1), { sub: s.id, end: { reason: "shutdown" } });
  s.offer(4, { topic: "anchor", stalled: true });
  assert.equal(sent.length, 3, "nothing after close");
  const quiet: OutboundFrame[] = [];
  const pending = new Subscription("P".repeat(22), new Set(["anchor"]), "w", { window: 4, queueMax: 2 }, (f) => quiet.push(f), () => 0);
  pending.close("shutdown");
  assert.equal(quiet.length, 0, "a subscription never activated gets no frame at all");
});

test("EV12 an ack frees only the frames up to its seq: partial, stale, out-of-order and over-large acks", async (t) => {
  const r = await eventsRig(t, { window: 3 });
  const c = { send: r.send, inbox: r.inbox };
  const sub = (await r.subscribe(c, "s1", { topics: ["workspaces"] })).result?.["subscriptionId"] as string;
  const seqs = async (id: string) => (await settle(c, id), framesOf(r.inbox, sub).map((f) => f.seq));
  for (let i = 1; i <= 5; i++) r.hub.publish(ws(`w${i}`));
  assert.deepEqual(await seqs("x1"), [1, 2, 3], "the window holds three");
  c.send({ v: 1, ack: sub, seq: 1 });
  assert.deepEqual(await seqs("x2"), [1, 2, 3, 4], "an ack of 1 frees exactly one frame");
  c.send({ v: 1, ack: sub, seq: 1 });
  c.send({ v: 1, ack: sub, seq: 0 });
  assert.deepEqual(await seqs("x3"), [1, 2, 3, 4], "a stale ack frees nothing");
  c.send({ v: 1, ack: sub, seq: 3 });
  assert.deepEqual(await seqs("x4"), [1, 2, 3, 4, 5], "an ack of 3 frees 2 and 3; only 5 was queued");
  for (let i = 6; i <= 9; i++) r.hub.publish(ws(`w${i}`));
  assert.deepEqual(await seqs("x5"), [1, 2, 3, 4, 5, 6], "4, 5 and 6 outstanding: the window is full again");
  c.send({ v: 1, ack: sub, seq: 2 });
  assert.deepEqual(await seqs("x6"), [1, 2, 3, 4, 5, 6], "an ack older than the outstanding frames frees nothing");
  c.send({ v: 1, ack: sub, seq: 99 });
  assert.deepEqual(await seqs("x7"), [1, 2, 3, 4, 5, 6, 7, 8, 9], "an ack beyond everything sent frees all, never more than the window");
});

test("EV13 drops stay counted after their subscription is gone", async (t) => {
  const r = await eventsRig(t, { window: 1, queueMax: 1 });
  const c = { send: r.send, inbox: r.inbox };
  const sub = (await r.subscribe(c, "s1", { topics: ["workspaces"] })).result?.["subscriptionId"] as string;
  for (let i = 0; i < 4; i++) r.hub.publish(ws(`w${i}`));
  const before = r.hub.dropped;
  assert.ok(before >= 2);
  c.send(ereq("u1", "unsubscribe", { subscriptionId: sub }));
  assert.equal((await c.inbox.response("u1")).ok, true);
  assert.equal(r.hub.dropped, before, "unsubscribing does not erase the count");
});
