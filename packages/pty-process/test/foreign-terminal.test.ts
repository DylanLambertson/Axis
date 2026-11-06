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
  r.service.serveData(data.b);
  data.a.send({ t: "spawn", req: "x", runId: "x", argv: ["/bin/sh"], cwd: "/", env: {}, cols: 80, rows: 24 });
  data.a.send({ t: "kill", term: "pty_x", signal: "SIGKILL" });
  await settle();
  assert.equal(r.requests.length, 0);
  assert.deepEqual(data.sent.b, [{ t: "refused", term: null, code: "unsupported" }, { t: "refused", term: null, code: "unsupported" }]);
});

test("PTY-7: attaching an id the daemon never issued is refused", async () => {
  const { r } = await withTerminal();
  const data = channelPair();
  r.service.serveData(data.b);
  data.a.send({ t: "attach", term: "pty_00000000000000000000000000000000" });
  await settle();
  assert.deepEqual(data.sent.b, [{ t: "refused", term: null, code: "unknown_terminal" }]);
});

test("PTY-7: a second connection cannot attach, write, resize or read a terminal another connection holds", async () => {
  const { r, term, child } = await withTerminal();
  const one = channelPair();
  const two = channelPair();
  r.service.serveData(one.b);
  r.service.serveData(two.b);
  one.a.send({ t: "attach", term });
  await settle();
  assert.deepEqual(one.sent.b, [{ t: "attached", term }]);
  two.a.send({ t: "attach", term });
  two.a.send({ t: "write", term, data: "evil\n" });
  two.a.send({ t: "resize", term, cols: 10, rows: 10 });
  await settle();
  assert.deepEqual(two.sent.b, [1, 2, 3].map(() => ({ t: "refused", term: null, code: "foreign_terminal" })));
  assert.deepEqual(child.written, []);
  assert.deepEqual(child.resized, []);
  child.emit("hello");
  await settle();
  assert.equal(two.sent.b.length, 3, "output goes only to the owner");
  assert.deepEqual(one.sent.b.at(-1), { t: "data", term, chunk: "hello" });
});

test("PTY-7: an owner can write and resize; an unattached connection cannot write", async () => {
  const { r, term, child } = await withTerminal();
  const one = channelPair();
  const stranger = channelPair();
  r.service.serveData(one.b);
  r.service.serveData(stranger.b);
  stranger.a.send({ t: "write", term, data: "x" });
  one.a.send({ t: "attach", term });
  one.a.send({ t: "write", term, data: "ls\n" });
  one.a.send({ t: "resize", term, cols: 100, rows: 30 });
  await settle();
  assert.deepEqual(child.written, ["ls\n"]);
  assert.deepEqual(child.resized, [[100, 30]]);
});

test("PTY-7: the daemon control channel never receives terminal output, only status", async () => {
  const { r, term, child } = await withTerminal();
  const one = channelPair();
  r.service.serveData(one.b);
  one.a.send({ t: "attach", term });
  await settle();
  child.emit("secret-looking output");
  child.exit({ exitCode: 3, signal: null });
  await settle();
  assert.ok(!JSON.stringify(r.pair.sent.b).includes("secret-looking"));
  assert.deepEqual(r.pair.sent.b.at(-1), { t: "exit", term, exitCode: 3, signal: null });
});

test("PTY-7: when the owner closes, another connection may attach (unguessable id)", async () => {
  const { r, term } = await withTerminal();
  const one = channelPair();
  const two = channelPair();
  r.service.serveData(one.b);
  r.service.serveData(two.b);
  one.a.send({ t: "attach", term });
  await settle();
  one.a.close();
  await settle();
  two.a.send({ t: "attach", term });
  await settle();
  assert.deepEqual(two.sent.b, [{ t: "attached", term }]);
});

test("PTY-7: a second control channel is refused while one is serving", async () => {
  const r = rig();
  const other = channelPair();
  r.service.serveControl(other.b);
  other.a.send({ t: "spawn", req: "z", runId: "x", argv: ["/bin/x"], cwd: "/w", env: {}, cols: 80, rows: 24 });
  await settle();
  assert.equal(r.requests.length, 0);
});
