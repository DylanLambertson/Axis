// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPtyProcessPort, createPtyService, OutputFlow, type DataReply } from "../src/index.js";
import { channelPair, counterRandom, FakeChild, FakeProcs, settle } from "../testing/helpers.js";
import { SPEC } from "../testing/rig.js";

const LIMITS = { high: 100, low: 40, hard: 300 };

test("OutputFlow: pauses once past high, drops past hard, resumes and reports the loss once under low", () => {
  const f = new OutputFlow(LIMITS);
  assert.deepEqual(f.offer(100), { send: true, pause: false }, "exactly high is allowed");
  assert.deepEqual(f.offer(100), { send: true, pause: true });
  assert.deepEqual(f.offer(100), { send: true, pause: false }, "paused once, not again");
  assert.deepEqual(f.offer(1), { send: false, pause: false }, "past hard: dropped");
  assert.deepEqual(f.ack(100), { resume: false, overflow: 0 }, "still above low");
  assert.deepEqual(f.ack(200), { resume: true, overflow: 1 });
  assert.deepEqual(f.ack(5), { resume: false, overflow: 0 }, "reported once");
  assert.deepEqual(f.offer(1), { send: true, pause: false });
});

test("OutputFlow: reset reports a paused child once; an over-ack clamps and leaves room for a full hard window", () => {
  const f = new OutputFlow(LIMITS);
  assert.deepEqual(f.offer(300), { send: true, pause: true });
  assert.equal(f.reset(), true);
  assert.equal(f.reset(), false);
  f.offer(10);
  assert.deepEqual(f.ack(1_000_000), { resume: false, overflow: 0 });
  assert.deepEqual(f.offer(300), { send: true, pause: true });
});

async function attached(limits = LIMITS, child?: FakeChild): Promise<{ svc: ReturnType<typeof createPtyService>; child: FakeChild; data: ReturnType<typeof channelPair>; term: string; replies: DataReply[] }> {
  const procs = new FakeProcs();
  const fake = child ?? new FakeChild(101);
  procs.live.add(fake.pid);
  const pair = channelPair();
  const svc = createPtyService({ spawn: () => fake, ops: procs, randomBytes: counterRandom(), flow: limits });
  svc.serveControl(pair.b);
  const port = createPtyProcessPort({ channel: pair.a, ops: procs });
  const h = await port.spawn(SPEC);
  const data = channelPair();
  svc.serveData(data.b, "c1");
  port.grant(h.terminalId, "c1");
  await settle();
  const replies: DataReply[] = [];
  data.a.onMessage((m) => void replies.push(m as DataReply));
  data.a.send({ t: "attach", term: h.terminalId });
  await settle();
  return { svc, child: fake, data, term: h.terminalId, replies };
}

test("service: unacknowledged output pauses the child, an ack resumes it, and nothing is sent past the hard bound", async () => {
  const { child, data, term, replies } = await attached();
  child.emit("x".repeat(120));
  assert.equal(child.pauses, 1, "past high: the child is paused");
  child.emit("x".repeat(170));
  child.emit("y".repeat(20));
  await settle();
  const sent = replies.filter((r) => r.t === "data").reduce((n, r) => n + (r as { chunk: string }).chunk.length, 0);
  assert.equal(sent, 290, "the chunk that would pass hard (300) is dropped, so at most hard characters are ever in flight");
  assert.equal(child.pauses, 1);
  data.a.send({ t: "ack", term, chars: 290 });
  await settle();
  assert.equal(child.resumes, 1);
  assert.deepEqual(replies.filter((r) => r.t === "overflow"), [{ t: "overflow", term, chars: 20 }]);
});

test("service: a child that cannot be paused still has its in-flight output bounded", async () => {
  const child = new FakeChild(101);
  Object.defineProperty(child, "pause", { value: undefined });
  Object.defineProperty(child, "resume", { value: undefined });
  const { replies } = await attached(LIMITS, child);
  for (let i = 0; i < 50; i++) child.emit("z".repeat(50));
  await settle();
  const sent = replies.filter((r) => r.t === "data").reduce((n, r) => n + (r as { chunk: string }).chunk.length, 0);
  assert.ok(sent <= LIMITS.hard, `sent ${sent}`);
});

test("service: a viewer that leaves or is replaced resumes a paused child, and its output is then dropped", async () => {
  const { child, data } = await attached();
  child.emit("x".repeat(150));
  assert.equal(child.pauses, 1);
  data.a.close();
  await settle();
  assert.equal(child.resumes, 1, "nobody will ever ack: a paused child would hang forever");
  child.emit("x".repeat(150));
  assert.equal(child.pauses, 1, "no viewer: nothing is counted or paused");
});

test("service: an ack from a connection that was never granted the terminal is refused and credits nothing", async () => {
  const { svc, child, term } = await attached();
  child.emit("x".repeat(150));
  const evil = channelPair();
  svc.serveData(evil.b, "evil");
  const got: DataReply[] = [];
  evil.a.onMessage((m) => void got.push(m as DataReply));
  evil.a.send({ t: "ack", term, chars: 150 });
  await settle();
  assert.deepEqual(got, [{ t: "refused", term: null, code: "foreign_terminal" }]);
  assert.equal(child.resumes, 0, "the output is still outstanding");
});

test("ack is validated: zero, negative, fractional, huge and extra fields are refused as invalid", async () => {
  const { data, term, replies } = await attached();
  for (const bad of [{ chars: 0 }, { chars: -1 }, { chars: 1.5 }, { chars: 1e12 }, { chars: 1, extra: 1 }]) data.a.send({ t: "ack", term, ...bad });
  await settle();
  assert.equal(replies.filter((r) => r.t === "refused").length, 5);
});
