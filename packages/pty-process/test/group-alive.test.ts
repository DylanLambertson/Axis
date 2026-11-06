// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPtyProcessPort, createPtyService, probeGroup, PtySpawnError } from "../src/index.js";
import { channelPair, FakeChild, settle, until, pipeSpawn } from "../testing/helpers.js";
import { rig, SPEC } from "../testing/rig.js";

test("groupAlive: stays true after the leader exits while a group member lives, false once the group is gone", async () => {
  const r = rig();
  const h = await r.port.spawn(SPEC);
  const child = r.children[0] as FakeChild;
  assert.equal(h.groupAlive(), true);
  let exited = false;
  h.onExit(() => void (exited = true));
  child.exit();
  await settle();
  assert.equal(exited, true);
  assert.equal(h.groupAlive(), true, "the leader is gone but the group is not");
  r.procs.live.delete(child.pid);
  assert.equal(h.groupAlive(), false);
});

test("groupAlive probes the NEGATIVE pgid with signal 0", async () => {
  const r = rig();
  const h = await r.port.spawn(SPEC);
  r.procs.calls.length = 0;
  h.groupAlive();
  assert.deepEqual(r.procs.calls, [[-101, 0]]);
});

test("groupAlive: EPERM counts as alive, ESRCH as gone, any other error throws (the caller counts it as alive)", async () => {
  const r = rig();
  const h = await r.port.spawn(SPEC);
  r.procs.failWith = "EPERM";
  assert.equal(h.groupAlive(), true);
  r.procs.failWith = "ESRCH";
  assert.equal(h.groupAlive(), false);
  r.procs.failWith = "EIO";
  assert.throws(() => h.groupAlive());
  r.procs.failWith = undefined;
  assert.throws(() => probeGroup(r.procs, 1));
  assert.throws(() => probeGroup(r.procs, 0));
  assert.throws(() => probeGroup(r.procs, Number.NaN));
});

test("groupAlive still answers after the pty process died, and no exit is invented as a success", async () => {
  const r = rig();
  const h = await r.port.spawn(SPEC);
  const exits: unknown[] = [];
  h.onExit((e) => exits.push(e));
  r.pair.a.close();
  await settle();
  assert.deepEqual(exits, [{ exitCode: null, signal: null }]);
  assert.equal(h.groupAlive(), true, "the group probe is local");
  r.procs.live.clear();
  assert.equal(h.groupAlive(), false);
});

test("a child that is not the leader of its own group is refused and no group signal is sent", async () => {
  const procs = rigless();
  const pair = channelPair();
  const child = new FakeChild(500, { kind: "pgid", pgid: 1 });
  const svc = createPtyService({ spawn: () => child, ops: procs });
  svc.serveControl(pair.b);
  const port = createPtyProcessPort({ channel: pair.a, ops: procs });
  await assert.rejects(port.spawn(SPEC), (e: unknown) => e instanceof PtySpawnError && e.code === "bad_group");
  assert.deepEqual(child.killed, ["SIGKILL"]);
  assert.deepEqual(procs.calls, []);
  const other = new FakeChild(501, { kind: "pgid", pgid: 777 });
  const svc2 = createPtyService({ spawn: () => other, ops: procs });
  const pair2 = channelPair();
  svc2.serveControl(pair2.b);
  await assert.rejects(createPtyProcessPort({ channel: pair2.a, ops: procs }).spawn(SPEC), (e: unknown) => e instanceof PtySpawnError && e.code === "bad_group");
  assert.deepEqual(procs.calls, []);
});

function rigless(): ReturnType<typeof rig>["procs"] {
  return rig().procs;
}

test("job group (Windows model): alive until the pty process reports the job empty, even after the leader exits", async () => {
  const pair = channelPair();
  const child = new FakeChild(900, { kind: "job" });
  const svc = createPtyService({ spawn: () => child });
  svc.serveControl(pair.b);
  const port = createPtyProcessPort({ channel: pair.a });
  const h = await port.spawn(SPEC);
  child.exit();
  await settle();
  assert.equal(h.groupAlive(), true);
  child.groupEmpty();
  await settle();
  assert.equal(h.groupAlive(), false);
});

test("real group (Linux/macOS): `sh -c 'sleep 30 & exit 0'` is alive after the leader exits and gone after the child is killed", { skip: process.platform === "win32" ? "POSIX process groups only" : false }, async () => {
  const pids: number[] = [];
  const pair = channelPair();
  const svc = createPtyService({ spawn: pipeSpawn(pids) });
  svc.serveControl(pair.b);
  const port = createPtyProcessPort({ channel: pair.a });
  try {
    const h = await port.spawn({ ...SPEC, argv: ["/bin/sh", "-c", "sleep 30 & exit 0"], cwd: "/", env: { PATH: "/usr/bin:/bin" } });
    let exited = false;
    h.onExit(() => void (exited = true));
    await until(() => exited);
    assert.equal(h.groupAlive(), true, "sleep outlives the leader");
    h.kill("SIGKILL");
    await until(() => !h.groupAlive());
  } finally {
    for (const p of pids) try { process.kill(-p, "SIGKILL"); } catch { /* gone */ }
    svc.dispose();
    port.dispose();
  }
});
