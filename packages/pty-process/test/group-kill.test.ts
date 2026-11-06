// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPtyProcessPort, createPtyService } from "../src/index.js";
import { channelPair, FakeChild, settle, until, pipeSpawn } from "../testing/helpers.js";
import { rig, SPEC } from "../testing/rig.js";

test("kill signals the whole process group (negative pgid), never the bare pid", async () => {
  const r = rig();
  const h = await r.port.spawn(SPEC);
  r.procs.calls.length = 0;
  h.kill("SIGTERM");
  await settle();
  assert.ok(r.procs.calls.some(([pid, s]) => pid === -101 && s === "SIGTERM"));
  assert.ok(r.procs.calls.every(([pid]) => pid < 0));
  assert.equal(r.children[0]?.killed.length, 0, "the leader is not signalled on its own");
});

test("kill after the leader exited still reaches a lingering group, and is a no-op once the group is gone", async () => {
  const r = rig();
  const h = await r.port.spawn(SPEC);
  r.children[0]?.exit();
  await settle();
  h.kill("SIGKILL");
  await settle();
  assert.equal(h.groupAlive(), false, "the fake group dies of SIGKILL");
  r.procs.calls.length = 0;
  h.kill("SIGKILL");
  await settle();
  assert.deepEqual(r.procs.calls.filter(([, s]) => s !== 0), [], "no blind signal to a group that no longer answers the probe");
});

test("an invalid signal is refused", async () => {
  const r = rig();
  const h = await r.port.spawn(SPEC);
  assert.throws(() => h.kill("SIGUSR1" as never));
});

test("when the pty process is gone the host signals the group itself", async () => {
  const r = rig();
  const h = await r.port.spawn(SPEC);
  r.pair.a.close();
  await settle();
  r.procs.calls.length = 0;
  h.kill("SIGKILL");
  assert.ok(r.procs.calls.some(([pid, s]) => pid === -101 && s === "SIGKILL"));
  assert.equal(h.groupAlive(), false);
});

test("service dispose kills every group with SIGKILL and closes the channels", async () => {
  const r = rig();
  await r.port.spawn(SPEC);
  await r.port.spawn({ ...SPEC, runId: "run2" });
  r.service.dispose();
  assert.deepEqual([...r.procs.live], []);
  assert.deepEqual(r.procs.calls.filter(([, s]) => s === "SIGKILL").map(([p]) => p).sort((a, b) => a - b), [-102, -101]);
  r.service.dispose(); // idempotent
});

test("job group kill goes through the child, which must end the whole job", async () => {
  const pair = channelPair();
  const child = new FakeChild(900, { kind: "job" });
  const svc = createPtyService({ spawn: () => child });
  svc.serveControl(pair.b);
  const h = await createPtyProcessPort({ channel: pair.a }).spawn(SPEC);
  h.kill("SIGKILL");
  await settle();
  assert.deepEqual(child.killed, ["SIGKILL"]);
});

const posix = { skip: process.platform === "win32" ? "POSIX process groups only" : false };

test("real processes: one kill takes down the leader and every member of its group", posix, async () => {
  const pids: number[] = [];
  const pair = channelPair();
  const svc = createPtyService({ spawn: pipeSpawn(pids) });
  svc.serveControl(pair.b);
  const port = createPtyProcessPort({ channel: pair.a });
  try {
    const script = "sleep 60 & sleep 60 & echo ready; wait";
    const h = await port.spawn({ ...SPEC, argv: ["/bin/sh", "-c", script], cwd: "/", env: { PATH: "/usr/bin:/bin" } });
    let exited = false;
    h.onExit(() => void (exited = true));
    assert.equal(h.groupAlive(), true);
    h.kill("SIGKILL");
    await until(() => exited);
    await until(() => !h.groupAlive());
  } finally {
    for (const p of pids) try { process.kill(-p, "SIGKILL"); } catch { /* gone */ }
    svc.dispose();
    port.dispose();
  }
});

test("real processes: dispose of the service kills the whole group", posix, async () => {
  const pids: number[] = [];
  const pair = channelPair();
  const svc = createPtyService({ spawn: pipeSpawn(pids) });
  svc.serveControl(pair.b);
  const port = createPtyProcessPort({ channel: pair.a });
  try {
    const h = await port.spawn({ ...SPEC, argv: ["/bin/sh", "-c", "sleep 60 & sleep 60 & wait"], cwd: "/", env: { PATH: "/usr/bin:/bin" } });
    svc.dispose();
    await until(() => !h.groupAlive());
  } finally {
    for (const p of pids) try { process.kill(-p, "SIGKILL"); } catch { /* gone */ }
    port.dispose();
  }
});
