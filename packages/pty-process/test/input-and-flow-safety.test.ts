// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPtyProcessPort, createPtyService, type Channel, type DataReply, type PtyChild, type SpawnFn } from "../src/index.js";
import { oscIds } from "../testing/osc-oracle.js";
import { channelPair, counterRandom, FakeChild, FakeProcs, pipeSpawn, settle, until } from "../testing/helpers.js";
import { SPEC } from "../testing/rig.js";

async function viewer(spawn: SpawnFn, opts: { real?: boolean; input?: { terminal?: number; process?: number; entriesTerminal?: number; entriesProcess?: number }; flow?: { high: number; low: number; hard: number } } = {}) {
  const procs = new FakeProcs();
  const pair = channelPair();
  const svc = createPtyService({ spawn: (r) => { const c = spawn(r); procs.live.add(c.pid); return c; }, ...(opts.real === true ? {} : { ops: procs }), randomBytes: counterRandom(), ...(opts.input === undefined ? {} : { input: opts.input }), ...(opts.flow === undefined ? {} : { flow: opts.flow }) });
  svc.serveControl(pair.b);
  const port = createPtyProcessPort({ channel: pair.a, ...(opts.real === true ? {} : { ops: procs }) });
  const h = await port.spawn({ ...SPEC, argv: ["/bin/sh", "-c", "sleep 30"], cwd: "/", env: { PATH: "/usr/bin:/bin" } });
  const data = channelPair();
  svc.serveData(data.b, "c1");
  port.grant(h.terminalId, "c1");
  await settle();
  const got: DataReply[] = [];
  data.a.onMessage((m) => void got.push(m as DataReply));
  data.a.send({ t: "attach", term: h.terminalId });
  await settle();
  return { status: pair.a, svc, port, handle: h, data, term: h.terminalId, got, close: () => (svc.dispose(), port.dispose()) };
}

test("PTY-4: input past the per-terminal bound is refused (input_full) and never reaches the child", async () => {
  const child = new FakeChild(101);
  const v = await viewer(() => child, { input: { terminal: 100, process: 1000 } });
  v.data.a.send({ t: "write", term: v.term, data: "a" });
  await settle();
  child.pending = 100; // the child has not read what was written
  v.data.a.send({ t: "write", term: v.term, data: "b" });
  await settle();
  assert.deepEqual(child.written, ["a"]);
  assert.deepEqual(v.got.filter((r) => r.t === "refused"), [{ t: "refused", term: v.term, code: "input_full" }]);
  child.pending = 99;
  v.data.a.send({ t: "write", term: v.term, data: "c" });
  await settle();
  assert.deepEqual(child.written, ["a"], "refused input stays refused until the child has taken everything: no spliced paste");
  child.pending = 0;
  v.data.a.send({ t: "write", term: v.term, data: "d" });
  await settle();
  assert.deepEqual(child.written, ["a", "d"], "input flows again once the child has taken it all");
  v.close();
});

test("PTY-4: the whole process is bounded too, and a child that cannot measure is unbounded only by its own choice", async () => {
  const children: FakeChild[] = [];
  const spawn: SpawnFn = () => (children.push(new FakeChild(101 + children.length)), children.at(-1) as PtyChild);
  const v = await viewer(spawn, { input: { terminal: 100, process: 150 } });
  const second = await v.port.spawn({ ...SPEC, argv: ["/bin/sh", "-c", "sleep 30"], cwd: "/", env: { PATH: "/usr/bin:/bin" } });
  void second;
  children[0]!.pending = 90;
  children[1]!.pending = 90; // each under its own bound, together over the process bound
  v.data.a.send({ t: "write", term: v.term, data: "x" });
  await settle();
  assert.deepEqual(children[0]!.written, []);
  assert.equal(v.got.some((r) => r.t === "refused" && r.code === "input_full"), true);
  v.close();
});

test("PTY-4: a daemon-side write past the bound is dropped as well, and flows again under it", async () => {
  const child = new FakeChild(101);
  const v = await viewer(() => child, { input: { terminal: 10, process: 100 } });
  child.pending = 10;
  v.handle.write("blocked");
  await settle();
  assert.deepEqual(child.written, []);
  child.pending = 0;
  v.handle.write("ok");
  await settle();
  assert.deepEqual(child.written, ["ok"]);
  v.close();
});

test("PTY-4 with a real child that never reads: a flood of maximum-size writes holds a bounded amount of input", { skip: process.platform === "win32" ? "POSIX" : false }, async () => {
  const limit = 256 * 1024;
  let child: PtyChild | undefined;
  const v = await viewer((r) => (child = pipeSpawn()(r)), { real: true, input: { terminal: limit, process: 4 * limit } });
  let peak = 0;
  const chunk = "x".repeat(65536);
  for (let i = 0; i < 400; i++) {
    v.data.a.send({ t: "write", term: v.term, data: chunk });
    if (i % 20 === 0) {
      await settle(2);
      peak = Math.max(peak, child?.pendingWrite?.() ?? 0);
    }
  }
  await until(() => v.got.some((r) => r.t === "refused"));
  peak = Math.max(peak, child?.pendingWrite?.() ?? 0);
  assert.ok(peak <= limit + 3 * 65536, `peak ${peak}`);
  assert.equal(v.got.some((r) => r.t === "refused" && r.code === "input_full"), true);
  v.close();
});

// A seeded stream of tokens that matter to the OSC parser, with chunk boundaries and drops decided by a counter.
function stream(seed: number): string[] {
  let x = seed >>> 0;
  const rnd = (n: number): number => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) >>> 8) % n;
  const tokens = ["\x1b", "]", "7", "0", "6", "3", ";", "x", "\x07", "\x1b\\", "\x9d", "\x18", "\x01", "file:///evil", "\x1b]7;file:///evil\x07", "\x1b]633;P;Cwd=/e\x07"];
  const chunks: string[] = [];
  for (let c = 0; c < 6; c++) {
    let s = "";
    for (let i = rnd(5) + 1; i > 0; i--) s += tokens[rnd(tokens.length)] as string;
    chunks.push(s + (rnd(4) === 0 ? "y".repeat(rnd(60)) : ""));
  }
  return chunks;
}

test("S1: dropping output (flow control) never lets a denied OSC id reach the viewer, over seeded streams with drops", async () => {
  const DENIED = new Set([7, 9, 133, 633, 1337]);
  const bad: number[] = [];
  for (let seed = 1; seed <= 300; seed++) {
    const child = new FakeChild(101);
    Object.defineProperty(child, "pause", { value: undefined });
    Object.defineProperty(child, "resume", { value: undefined });
    const v = await viewer(() => child, { flow: { high: 20, low: 5, hard: 60 } });
    for (const chunk of stream(seed)) child.emit(chunk);
    await settle(1);
    const received = v.got.filter((r) => r.t === "data").map((r) => (r as { chunk: string }).chunk).join("");
    if (oscIds(received).some((id) => DENIED.has(id))) bad.push(seed);
    v.close();
  }
  assert.deepEqual(bad, []);
});

test("S1: the exact stream from the review (a dropped chunk carrying the ] of a started OSC) yields no OSC 7", async () => {
  const child = new FakeChild(101);
  Object.defineProperty(child, "pause", { value: undefined });
  Object.defineProperty(child, "resume", { value: undefined });
  const v = await viewer(() => child, { flow: { high: 100, low: 40, hard: 300 } });
  child.emit("\x1b]0;t");
  child.emit("\x1b\x01");
  child.emit("]0;" + "x".repeat(400) + "\x07");
  child.emit("]7;file:///evil\x07");
  await settle(1);
  const received = v.got.filter((r) => r.t === "data").map((r) => (r as { chunk: string }).chunk).join("");
  assert.deepEqual(oscIds(received).filter((id) => id === 7), []);
  assert.ok(received.includes("\x18]7;file:///evil"), "after the gap CAN comes first, so the ] that follows is plain text to the viewer parser");
  v.close();
});

test("S1: a viewer that re-attaches after a gap starts with CAN and a fresh filter; the first attach adds nothing", async () => {
  const child = new FakeChild(101);
  const v = await viewer(() => child);
  child.emit("one");
  await settle(1);
  assert.deepEqual(v.got.filter((r) => r.t === "data").map((r) => (r as { chunk: string }).chunk), ["one"]);
  child.emit("\x1b]633;P;Cwd=/e"); // withheld: the sequence is still open in the filter
  v.data.a.send({ t: "attach", term: v.term }); // same owner: no gap
  await settle();
  child.emit("\x07after");
  await settle(1);
  const all = v.got.filter((r) => r.t === "data").map((r) => (r as { chunk: string }).chunk).join("");
  assert.equal(all.includes("Cwd"), false);
  v.close();
});

/** A channel that counts its live listeners. */
function counting(): { channel: Channel; live: () => number; peer: Channel; pair: ReturnType<typeof channelPair> } {
  const pair = channelPair();
  let live = 0;
  const wrap = pair.b;
  const channel: Channel = {
    send: (m) => wrap.send(m),
    onMessage: (l) => (live++, ((d) => ({ dispose: () => (d.dispose(), void live-- ) }))(wrap.onMessage(l))),
    onClose: (l) => (live++, ((d) => ({ dispose: () => (d.dispose(), void live--) }))(wrap.onClose(l))),
    close: () => wrap.close(),
  };
  return { channel, live: () => live, peer: pair.a, pair };
}

test("S3: a closed data channel releases its listeners (one view per port, many views)", async () => {
  const svc = createPtyService({ spawn: () => new FakeChild(101), ops: new FakeProcs(), randomBytes: counterRandom() });
  const probes = [];
  for (let i = 0; i < 50; i++) {
    const c = counting();
    svc.serveData(c.channel, `view-${i}`);
    assert.equal(c.live(), 2);
    c.peer.close();
    probes.push(c);
  }
  await settle();
  assert.deepEqual(probes.map((p) => p.live()), probes.map(() => 0));
  svc.dispose();
});

test("PTY-4: a child whose input meter throws counts as full (fail closed)", async () => {
  const child = new FakeChild(101);
  child.pendingWrite = () => {
    throw new Error("meter broke");
  };
  const v = await viewer(() => child);
  v.data.a.send({ t: "write", term: v.term, data: "x" });
  await settle();
  assert.deepEqual(child.written, []);
  assert.equal(v.got.some((r) => r.t === "refused" && r.code === "input_full"), true);
  v.close();
});

test("flow: output the OSC filter removes is not charged to the viewer, which will never acknowledge it", async () => {
  const child = new FakeChild(101);
  const v = await viewer(() => child, { flow: { high: 100, low: 40, hard: 300 } });
  for (let i = 0; i < 30; i++) child.emit("\x1b]633;P;Cwd=/" + "e".repeat(80) + "\x07"); // 3000 characters in, nothing out
  child.emit("visible");
  await settle(1);
  const received = v.got.filter((r) => r.t === "data").map((r) => (r as { chunk: string }).chunk).join("");
  assert.ok(received.endsWith("visible"), "not dropped for output the viewer never saw");
  assert.equal(child.pauses, 0);
  v.close();
});

test("PTY-4: the number of queued writes is bounded too, checked before any byte count, for the terminal and for the process", async () => {
  const child = new FakeChild(101);
  let scans = 0;
  child.pendingWrite = () => (scans++, 1);
  const v = await viewer(() => child, { input: { entriesTerminal: 5, entriesProcess: 100 } });
  child.entries = 5;
  v.data.a.send({ t: "write", term: v.term, data: "ok" });
  await settle();
  assert.deepEqual(child.written, ["ok"]);
  child.entries = 6; // one-byte writes into a child that never reads: tiny in bytes, expensive in entries
  scans = 0;
  v.data.a.send({ t: "write", term: v.term, data: "x" });
  await settle();
  assert.deepEqual(child.written, ["ok"]);
  assert.equal(scans, 0, "refused on the O(1) entry count; no queue was scanned for bytes");
  assert.equal(v.got.some((r) => r.t === "refused" && r.code === "input_full"), true);
  v.close();
});

test("PTY-4: the process-wide entry bound refuses a terminal whose own queue is small", async () => {
  const children: FakeChild[] = [];
  const v = await viewer(() => (children.push(new FakeChild(101 + children.length)), children.at(-1) as PtyChild), { input: { entriesTerminal: 10, entriesProcess: 12 } });
  await v.port.spawn({ ...SPEC, argv: ["/bin/sh", "-c", "sleep 30"], cwd: "/", env: { PATH: "/usr/bin:/bin" } });
  children[0]!.entries = 8;
  children[1]!.entries = 8;
  v.data.a.send({ t: "write", term: v.term, data: "x" });
  await settle();
  assert.deepEqual(children[0]!.written, []);
  v.close();
});

test("PTY-4: the daemon is told when its input was dropped (status only), and a blocked terminal stays blocked until drained", async () => {
  const child = new FakeChild(101);
  const v = await viewer(() => child, { input: { terminal: 10 } });
  const status: unknown[] = [];
  v.status.onMessage((m) => void status.push(m));
  child.pending = 10;
  v.handle.write("one");
  await settle();
  child.pending = 3;
  v.handle.write("two");
  await settle();
  assert.deepEqual(child.written, []);
  assert.deepEqual(status.filter((m) => (m as { t: string }).t === "input-refused").length, 2);
  v.close();
});

test("S1: switching viewers mid-sequence gives the returning viewer a CAN and a fresh filter (no forged OSC 7)", async () => {
  const child = new FakeChild(101);
  const v = await viewer(() => child);
  child.emit("\x1b]"); // viewer A's parser is now inside an OSC, waiting for its id
  await settle(1);
  const b = channelPair();
  v.svc.serveData(b.b, "c2");
  v.port.grant(v.term, "c2");
  await settle();
  b.a.send({ t: "attach", term: v.term });
  await settle();
  child.emit("junk-for-b");
  await settle(1);
  v.port.grant(v.term, "c1b");
  const a2 = channelPair();
  v.svc.serveData(a2.b, "c1b");
  await settle();
  const got: DataReply[] = [];
  a2.a.onMessage((m) => void got.push(m as DataReply));
  a2.a.send({ t: "attach", term: v.term });
  await settle();
  child.emit("7;file:///e\x07tail");
  await settle(1);
  const text = got.filter((r) => r.t === "data").map((r) => (r as { chunk: string }).chunk).join("");
  assert.ok(text.startsWith("\x18"), "CAN first");
  assert.deepEqual(oscIds(text), [], "no OSC starts in what the returning viewer sees");
  assert.ok(text.includes("7;file:///e"), "the text after the gap arrives as plain text, not as an OSC id");
  v.close();
});

test("PTY-4: the process-wide byte refusal is sticky too: a terminal under its own bound stays refused until drained", async () => {
  const children: FakeChild[] = [];
  const v = await viewer(() => (children.push(new FakeChild(101 + children.length)), children.at(-1) as PtyChild), { input: { terminal: 100, process: 150 } });
  await v.port.spawn({ ...SPEC, argv: ["/bin/sh", "-c", "sleep 30"], cwd: "/", env: { PATH: "/usr/bin:/bin" } });
  children[0]!.pending = 20;
  children[1]!.pending = 140; // together over the process bound
  v.data.a.send({ t: "write", term: v.term, data: "x" });
  await settle();
  children[1]!.pending = 0; // the other terminal drained: now only this one's 20 bytes remain
  v.data.a.send({ t: "write", term: v.term, data: "y" });
  await settle();
  assert.deepEqual(children[0]!.written, [], "still refused: its own queue has not drained");
  children[0]!.pending = 0;
  v.data.a.send({ t: "write", term: v.term, data: "z" });
  await settle();
  assert.deepEqual(children[0]!.written, ["z"]);
  v.close();
});

test("a connection name is single use in the service too, also after its port closed, and the number of names is capped", async () => {
  const svc = createPtyService({ spawn: () => new FakeChild(101), ops: new FakeProcs(), randomBytes: counterRandom(), maxConnNames: 3 });
  const ends: Array<ReturnType<typeof channelPair>> = [];
  const serve = (name: string): ReturnType<typeof channelPair> => {
    const p = channelPair();
    svc.serveData(p.b, name);
    ends.push(p);
    return p;
  };
  const first = serve("a");
  first.a.close();
  await settle();
  const reused = serve("a");
  await settle();
  assert.throws(() => reused.a.send({}), /closed/, "a closed name stays used");
  serve("b");
  serve("c");
  const over = serve("d");
  await settle();
  assert.throws(() => over.a.send({}), /closed/, "past the cap a new name is refused");
  svc.dispose();
});
