// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPtyProcessPort, createPtyService, PtySpawnError } from "../src/index.js";
import { channelPair, FakeChild, FakeProcs, ManualClock, settle } from "../testing/helpers.js";
import { rig, SPEC } from "../testing/rig.js";

const code = (c: string) => (e: unknown): boolean => e instanceof PtySpawnError && e.code === c;

function silentPort(extra: { maxPending?: number } = {}): { port: ReturnType<typeof createPtyProcessPort>; pair: ReturnType<typeof channelPair>; clock: ManualClock } {
  const pair = channelPair(); // nothing serves pair.b: the pty process never answers
  const clock = new ManualClock();
  return { port: createPtyProcessPort({ channel: pair.a, clock, ...extra }), pair, clock };
}

test("a spawn nobody answers rejects with `timeout` when the bound fires, and leaves no timer", async () => {
  const { port, clock } = silentPort();
  const p = port.spawn(SPEC);
  assert.equal(clock.timers.size, 1);
  clock.fire();
  await assert.rejects(p, code("timeout"));
  assert.equal(clock.timers.size, 0);
});

test("the bound is the configured milliseconds", async () => {
  const seen: number[] = [];
  const pair = channelPair();
  const port = createPtyProcessPort({ channel: pair.a, spawnTimeoutMs: 1234, clock: { setTimeout: (_f, ms) => (seen.push(ms), 1), clearTimeout: () => undefined } });
  void port.spawn(SPEC).catch(() => undefined);
  assert.deepEqual(seen, [1234]);
});

test("the default bound is ten seconds", () => {
  const seen: number[] = [];
  const port = createPtyProcessPort({ channel: channelPair().a, clock: { setTimeout: (_f, ms) => (seen.push(ms), 1), clearTimeout: () => undefined } });
  void port.spawn(SPEC).catch(() => undefined);
  assert.deepEqual(seen, [10000]);
});

test("a late `spawned` after the timeout kills the orphan group instead of leaking it", async () => {
  const { port, pair, clock } = silentPort();
  const p = port.spawn(SPEC);
  const req = (pair.sent.a[0] as { req: string }).req;
  clock.fire();
  await assert.rejects(p, code("timeout"));
  pair.b.send({ t: "spawned", req, term: "pty_late", group: { kind: "pgid", pgid: 4242 } });
  await settle();
  assert.deepEqual(pair.sent.a.at(-1), { t: "kill", term: "pty_late", signal: "SIGKILL" });
});

test("closing the channel rejects every pending spawn, and later spawns reject at once", async () => {
  const { port, pair } = silentPort();
  const a = port.spawn(SPEC);
  const b = port.spawn(SPEC);
  pair.b.close();
  await assert.rejects(a, code("channel_closed"));
  await assert.rejects(b, code("channel_closed"));
  await assert.rejects(port.spawn(SPEC), code("channel_closed"));
});

test("a channel whose send throws rejects the spawn and clears its timer", async () => {
  const pair = channelPair();
  const clock = new ManualClock();
  const port = createPtyProcessPort({ channel: { ...pair.a, send: () => { throw new Error("EPIPE"); } }, clock });
  await assert.rejects(port.spawn(SPEC), code("channel_closed"));
  assert.equal(clock.timers.size, 0);
});

test("dispose rejects pending spawns and clears their timers", async () => {
  const { port, clock } = silentPort();
  const p = port.spawn(SPEC);
  port.dispose();
  await assert.rejects(p, code("channel_closed"));
  assert.equal(clock.timers.size, 0);
});

test("pending spawns are capped", async () => {
  const { port } = silentPort({ maxPending: 2 });
  const a = port.spawn(SPEC);
  const b = port.spawn(SPEC);
  await assert.rejects(port.spawn(SPEC), code("capacity"));
  port.dispose();
  await assert.rejects(a, code("channel_closed"));
  await assert.rejects(b, code("channel_closed"));
});

test("a spawn function that throws is a rejected spawn (code only), not a hang", async () => {
  const r = rig({ spawn: () => { throw new Error("ENOENT /secret/path"); } });
  const err = await r.port.spawn(SPEC).catch((e: unknown) => e as Error);
  assert.ok(err instanceof PtySpawnError && err.code === "spawn_failed");
  assert.ok(!err.message.includes("/secret/path"));
});

test("a malformed spawn request still gets an answer, so the daemon does not wait for its bound", async () => {
  const pair = channelPair();
  const svc = createPtyService({ spawn: () => new FakeChild(5), ops: new FakeProcs() });
  svc.serveControl(pair.b);
  pair.a.send({ t: "spawn", req: "bad1", runId: "x", argv: [], cwd: "/", env: {}, cols: 80, rows: 24 });
  await settle();
  assert.deepEqual(pair.sent.b, [{ t: "spawn-failed", req: "bad1", code: "spawn_failed" }]);
});

test("the terminal cap refuses a spawn with `capacity`; a finished and gone terminal frees its slot", async () => {
  const r = rig({ maxTerminals: 1 });
  const h = await r.port.spawn(SPEC);
  await assert.rejects(r.port.spawn(SPEC), code("capacity"));
  r.children[0]?.exit();
  r.procs.live.clear();
  await settle();
  void h;
  await r.port.spawn(SPEC);
});

test("a malicious reply (wrong shape) is ignored and does not settle or crash", async () => {
  const { port, pair, clock } = silentPort();
  const p = port.spawn(SPEC);
  pair.b.send({ t: "spawned", req: "r1", term: 5 });
  pair.b.send("junk");
  await settle();
  clock.fire();
  await assert.rejects(p, code("timeout"));
});
