// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPtyService } from "../src/index.js";
import { channelPair, FakeChild, settle } from "../testing/helpers.js";
import { rig, SPEC } from "../testing/rig.js";

async function withTerminal(): Promise<{ r: ReturnType<typeof rig>; term: string; child: FakeChild }> {
  const r = rig();
  await r.port.spawn(SPEC);
  const spawned = r.pair.sent.b.find((m) => (m as { t: string }).t === "spawned") as { term: string };
  return { r, term: spawned.term, child: r.children[0] as FakeChild };
}

test("PTY-7: terminal ids are unguessable (pty_ plus 128 random bits) and distinct", async () => {
  const ids = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const pair = channelPair();
    let pid = 10;
    const svc = createPtyService({ spawn: () => new FakeChild(++pid) }); // default node:crypto source
    svc.serveControl(pair.b);
    pair.a.onMessage((m) => ids.add((m as { term?: string }).term ?? ""));
    pair.a.send({ t: "spawn", req: "r", runId: "x", argv: ["/bin/x"], cwd: "/w", env: {}, cols: 80, rows: 24 });
    await settle();
    svc.dispose();
  }
  ids.delete("");
  assert.equal(ids.size, 20);
  for (const id of ids) assert.match(id, /^pty_[0-9a-f]{32}$/);
});

test("PTY-7: a data channel cannot spawn; the spawn function is never called", async () => {
  const r = rig();
  const data = channelPair();
  r.service.serveData(data.b, "c1");
  data.a.send({ t: "spawn", req: "x", runId: "x", argv: ["/bin/sh"], cwd: "/", env: {}, cols: 80, rows: 24 });
  data.a.send({ t: "kill", term: "pty_x", signal: "SIGKILL" });
  data.a.send({ t: "grant", term: "pty_x", conn: "c1" });
  await settle();
  assert.equal(r.requests.length, 0);
  assert.deepEqual(data.sent.b, [1, 2, 3].map(() => ({ t: "refused", term: null, code: "unsupported" })));
});

const REFUSED = { t: "refused", term: null, code: "foreign_terminal" };

test("G-2: an id the daemon never issued is refused, with the same answer as an id granted to someone else", async () => {
  const { r, term } = await withTerminal();
  const data = channelPair();
  r.service.serveData(data.b, "c1");
  data.a.send({ t: "attach", term: "pty_00000000000000000000000000000000" });
  data.a.send({ t: "attach", term });
  await settle();
  assert.deepEqual(data.sent.b, [REFUSED, REFUSED]);
});

test("G-2: attach without a grant is refused; a pre-claim cannot take the terminal before its granted connection", async () => {
  const { r, term, child } = await withTerminal();
  const intruder = channelPair();
  const owner = channelPair();
  r.service.serveData(intruder.b, "evil");
  r.service.serveData(owner.b, "win1");
  intruder.a.send({ t: "attach", term }); // pre-claim: no grant exists yet
  await settle();
  assert.deepEqual(intruder.sent.b, [REFUSED]);
  r.port.grant(term, "win1");
  await settle();
  intruder.a.send({ t: "attach", term });
  owner.a.send({ t: "attach", term });
  await settle();
  assert.deepEqual(intruder.sent.b, [REFUSED, REFUSED]);
  assert.deepEqual(owner.sent.b, [{ t: "attached", term }]);
  child.emit("hello");
  await settle();
  assert.deepEqual(owner.sent.b.at(-1), { t: "data", term, chunk: "hello" });
  assert.equal(intruder.sent.b.length, 2, "output goes only to the owner");
});

test("G-2: another connection cannot steal, write to or resize a terminal granted to and attached by a connection", async () => {
  const { r, term, child } = await withTerminal();
  const one = channelPair();
  const two = channelPair();
  r.service.serveData(one.b, "win1");
  r.service.serveData(two.b, "win2");
  r.port.grant(term, "win1");
  await settle();
  one.a.send({ t: "attach", term });
  await settle();
  two.a.send({ t: "attach", term });
  two.a.send({ t: "write", term, data: "evil\n" });
  two.a.send({ t: "resize", term, cols: 10, rows: 10 });
  await settle();
  assert.deepEqual(two.sent.b, [REFUSED, REFUSED, REFUSED]);
  assert.deepEqual(child.written, []);
  assert.deepEqual(child.resized, []);
});

test("G-2: a granted connection that has not attached cannot write; once attached it can write and resize", async () => {
  const { r, term, child } = await withTerminal();
  const one = channelPair();
  r.service.serveData(one.b, "win1");
  r.port.grant(term, "win1");
  await settle();
  one.a.send({ t: "write", term, data: "x" });
  one.a.send({ t: "attach", term });
  one.a.send({ t: "write", term, data: "ls\n" });
  one.a.send({ t: "resize", term, cols: 100, rows: 30 });
  await settle();
  assert.deepEqual(one.sent.b[0], REFUSED);
  assert.deepEqual(child.written, ["ls\n"]);
  assert.deepEqual(child.resized, [[100, 30]]);
});

test("G-2: when the granted connection closes the id cannot be reused by another connection, nor by the same name, without a new grant", async () => {
  const { r, term } = await withTerminal();
  const one = channelPair();
  r.service.serveData(one.b, "win1");
  r.port.grant(term, "win1");
  await settle();
  one.a.send({ t: "attach", term });
  await settle();
  one.a.close();
  await settle();
  const two = channelPair();
  const again = channelPair();
  r.service.serveData(two.b, "win2");
  r.service.serveData(again.b, "win1"); // the same connection name, reconnected
  two.a.send({ t: "attach", term });
  await settle();
  assert.deepEqual(two.sent.b, [REFUSED]);
  assert.throws(() => again.a.send({ t: "attach", term }), /closed/, "the service closes a port that reuses a name: names are single use");
  assert.deepEqual(again.sent.b, []);
  r.port.grant(term, "win2"); // main brokers a new port: only now
  await settle();
  two.a.send({ t: "attach", term });
  await settle();
  assert.deepEqual(two.sent.b.at(-1), { t: "attached", term });
});

test("G-2: a re-grant to another connection detaches the first one", async () => {
  const { r, term, child } = await withTerminal();
  const one = channelPair();
  const two = channelPair();
  r.service.serveData(one.b, "win1");
  r.service.serveData(two.b, "win2");
  r.port.grant(term, "win1");
  await settle();
  one.a.send({ t: "attach", term });
  await settle();
  r.port.grant(term, "win2");
  await settle();
  child.emit("later");
  one.a.send({ t: "write", term, data: "x" });
  await settle();
  assert.equal(one.sent.b.at(-1) !== undefined && (one.sent.b.at(-1) as { t: string }).t, "refused");
  assert.ok(!JSON.stringify(one.sent.b).includes("later"));
  assert.deepEqual(child.written, []);
});

test("G-2: two channels cannot share one connection name; the second is closed", async () => {
  const r = rig();
  const a = channelPair();
  const b = channelPair();
  r.service.serveData(a.b, "win1");
  let closed = false;
  b.b.onClose(() => void (closed = true));
  r.service.serveData(b.b, "win1");
  await settle();
  assert.equal(closed, true);
});

test("G-2: only the control channel can grant; a grant for an unknown terminal is ignored", async () => {
  const { r, term } = await withTerminal();
  r.port.grant("pty_00000000000000000000000000000000", "win1");
  const one = channelPair();
  r.service.serveData(one.b, "win1");
  await settle();
  one.a.send({ t: "attach", term });
  await settle();
  assert.deepEqual(one.sent.b, [REFUSED]);
});

test("PTY-7: the daemon control channel never receives terminal output, only status", async () => {
  const { r, term, child } = await withTerminal();
  const one = channelPair();
  r.service.serveData(one.b, "c1");
  r.port.grant(term, "c1");
  await settle();
  one.a.send({ t: "attach", term });
  await settle();
  child.emit("secret-looking output");
  child.exit({ exitCode: 3, signal: null });
  await settle();
  assert.ok(!JSON.stringify(r.pair.sent.b).includes("secret-looking"));
  assert.deepEqual(r.pair.sent.b.at(-1), { t: "exit", term, exitCode: 3, signal: null });
});

test("PTY-7: a second control channel is refused while one is serving", async () => {
  const r = rig();
  const other = channelPair();
  r.service.serveControl(other.b);
  other.a.send({ t: "spawn", req: "z", runId: "x", argv: ["/bin/x"], cwd: "/w", env: {}, cols: 80, rows: 24 });
  await settle();
  assert.equal(r.requests.length, 0);
});
