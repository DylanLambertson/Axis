// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPtyProcessPort, createPtyService, PtySpawnError, type Channel } from "../src/index.js";
import { channelPair, FakeChild, FakeProcs, ManualClock, settle } from "../testing/helpers.js";
import { rig, SPEC } from "../testing/rig.js";

const SPAWN = { t: "spawn", req: "r1", runId: "x", argv: ["/bin/x"], cwd: "/w", env: {}, cols: 80, rows: 24 } as const;

test("S2: a spawn in flight when the control channel closes is killed when its child exists, and nothing keeps running", async () => {
  const r = rig();
  const p = r.port.spawn(SPEC);
  p.catch(() => undefined);
  r.pair.a.close(); // the daemon side goes away with the spawn message still queued
  await settle();
  await assert.rejects(p, (e: unknown) => e instanceof PtySpawnError && e.code === "channel_closed");
  assert.deepEqual([...r.procs.live], [], "the child's group is gone");
  assert.ok(r.procs.calls.some(([pid, s]) => pid === -101 && s === "SIGKILL"));
});

test("S2: when the spawned reply cannot be delivered the group is killed at once and the slot is freed", async () => {
  const procs = new FakeProcs();
  const pair = channelPair();
  const failing: Channel = { ...pair.b, send: () => { throw new Error("closed"); } };
  const svc = createPtyService({ spawn: () => (procs.live.add(300), new FakeChild(300)), ops: procs, maxTerminals: 1 });
  svc.serveControl(failing);
  pair.a.send(SPAWN);
  await settle();
  assert.deepEqual([...procs.live], []);
  assert.ok(procs.calls.some(([pid, s]) => pid === -300 && s === "SIGKILL"));
});

test("S2: closing the control channel ends every running terminal, tells the attached viewer, and frees the slots", async () => {
  const r = rig({ maxTerminals: 2 });
  const a = await r.port.spawn(SPEC);
  const b = await r.port.spawn({ ...SPEC, runId: "run2" });
  const data = channelPair();
  r.service.serveData(data.b, "c1");
  r.port.grant(a.terminalId, "c1");
  await settle();
  data.a.send({ t: "attach", term: a.terminalId });
  await settle();
  assert.equal(r.procs.live.size, 2);
  r.pair.a.close();
  await settle();
  assert.deepEqual([...r.procs.live], [], "both groups were killed");
  assert.deepEqual(data.sent.b.at(-1), { t: "exit", term: a.terminalId });
  void b;
  // a new control channel (a restarted daemon) starts from nothing, with the capacity back
  const next = channelPair();
  r.service.serveControl(next.b);
  next.a.send({ ...SPAWN, req: "r2" });
  await settle();
  assert.equal((next.sent.b.at(-1) as { t: string }).t, "spawned");
});

test("S2: a spawn message delivered after the control channel closed starts nothing", () => {
  let onMessage: ((m: unknown) => void) | undefined;
  let onClose: (() => void) | undefined;
  const channel: Channel = {
    send: () => undefined,
    onMessage: (l) => ((onMessage = l), { dispose: () => undefined }),
    onClose: (l) => ((onClose = l), { dispose: () => undefined }),
    close: () => undefined,
  };
  let started = 0;
  const svc = createPtyService({ spawn: () => (started++, new FakeChild(1)), ops: new FakeProcs() });
  svc.serveControl(channel);
  onClose?.();
  onMessage?.(SPAWN); // already in flight inside the transport
  assert.equal(started, 0);
});

test("S2: the host port itself kills the groups it knows when its channel closes (no service to do it)", async () => {
  const pair = channelPair(); // nothing serves pair.b
  const procs = new FakeProcs();
  procs.live.add(777);
  const port = createPtyProcessPort({ channel: pair.a, ops: procs });
  const p = port.spawn(SPEC);
  const req = (pair.sent.a.at(-1) as { req: string }).req;
  pair.b.send({ t: "spawned", req, term: "pty_a", group: { kind: "pgid", pgid: 777 } });
  await p;
  pair.b.close();
  await settle();
  assert.deepEqual([...procs.live], []);
  procs.live.add(778);
  const pair2 = channelPair();
  const port2 = createPtyProcessPort({ channel: pair2.a, ops: procs });
  const p2 = port2.spawn(SPEC);
  pair2.b.send({ t: "spawned", req: (pair2.sent.a.at(-1) as { req: string }).req, term: "pty_b", group: { kind: "pgid", pgid: 778 } });
  await p2;
  port2.dispose();
  assert.deepEqual([...procs.live], [], "dispose ends the group too");
});

test("N7: dispose releases the service's own channel listeners", async () => {
  let live = 0;
  const counting = (): Channel => {
    const pair = channelPair();
    return {
      ...pair.b,
      onMessage: (l) => { live++; const d = pair.b.onMessage(l); return { dispose: () => (live--, d.dispose()) }; },
      onClose: (l) => { live++; const d = pair.b.onClose(l); return { dispose: () => (live--, d.dispose()) }; },
    };
  };
  const svc = createPtyService({ spawn: () => new FakeChild(1), ops: new FakeProcs() });
  svc.serveControl(counting());
  svc.serveData(counting(), "c1");
  assert.equal(live, 4);
  svc.dispose();
  assert.equal(live, 0);
});

test("N2: a reply naming a pgid below 2 is ignored (the host never signals 0, 1 or a negative group); the spawn then times out", async () => {
  for (const pgid of [0, 1, -1]) {
    const pair = channelPair();
    const procs = new FakeProcs();
    const clock = new ManualClock();
    const port = createPtyProcessPort({ channel: pair.a, ops: procs, clock });
    const p = port.spawn(SPEC);
    const req = (pair.sent.a.at(-1) as { req: string }).req;
    pair.b.send({ t: "spawned", req, term: "pty_x", group: { kind: "pgid", pgid } });
    await settle();
    clock.fire();
    await assert.rejects(p, (e: unknown) => e instanceof PtySpawnError && e.code === "timeout", String(pgid));
    assert.deepEqual(procs.calls, []);
    port.dispose();
  }
});
