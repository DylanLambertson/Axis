// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-3a review 2 nit 1: the port signals a tracked group directly (at dispose, or when the pty process is gone) only while the id is
// still ours. A group id is its leader's pid: while the leader lives the id cannot be reused. Once the leader is known to have
// exited, a process now holding that pid means the id may be someone else's group, so it is not signalled. Without a way to tell
// (a platform with no answer), it is not signalled either: the pty process ends its own groups when its control channel closes.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { createPtyProcessPort } from "../src/index.js";
import { channelPair, FakeProcs, ManualClock, settle } from "../testing/helpers.js";
import { SPEC } from "../testing/rig.js";

function port(leader: (pid: number) => boolean | undefined) {
  const pair = channelPair();
  const procs = new FakeProcs();
  const p = createPtyProcessPort({ channel: pair.a, clock: new ManualClock(), ops: procs, leaderPresent: leader });
  return { p, pair, procs };
}
async function spawned(s: ReturnType<typeof port>, pgid: number) {
  const h = s.p.spawn(SPEC);
  const req = (s.pair.sent.a.at(-1) as { req: string }).req;
  s.procs.live.add(pgid);
  s.pair.b.send({ t: "spawned", req, term: `pty_${String(pgid).padStart(32, "0")}`, group: { kind: "pgid", pgid } });
  return h;
}
const killed = (s: ReturnType<typeof port>, pgid: number): boolean => s.procs.calls.some(([pid, sig]) => pid === -pgid && sig === "SIGKILL");

test("a group whose leader is still running is signalled at dispose", async () => {
  const s = port(() => true);
  await spawned(s, 4242);
  s.p.dispose();
  assert.equal(killed(s, 4242), true);
});

test("a group whose leader exited, with the leader's pid now held by another process, is NOT signalled", async () => {
  const s = port(() => true); // a process holds the pid: not our leader any more
  await spawned(s, 4242);
  s.pair.b.send({ t: "exit", term: `pty_${"4242".padStart(32, "0")}`, exitCode: 0, signal: null });
  await settle();
  s.p.dispose();
  assert.equal(killed(s, 4242), false, "the reused id is someone else's");
});

test("a group whose leader exited and whose pid is free (survivors of ours may remain) is signalled", async () => {
  const s = port(() => false);
  await spawned(s, 4242);
  s.pair.b.send({ t: "exit", term: `pty_${"4242".padStart(32, "0")}`, exitCode: 0, signal: null });
  await settle();
  s.p.dispose();
  assert.equal(killed(s, 4242), true);
});

test("with no way to tell after the leader's exit, the group is not signalled (the pty process ends it)", async () => {
  const s = port(() => undefined);
  await spawned(s, 4242);
  s.pair.b.send({ t: "exit", term: `pty_${"4242".padStart(32, "0")}`, exitCode: 0, signal: null });
  await settle();
  s.p.dispose();
  assert.equal(killed(s, 4242), false);
});

test("the direct kill of a handle once the pty process is gone follows the same rule", async () => {
  const s = port(() => true);
  const h = await spawned(s, 4242);
  s.pair.b.send({ t: "exit", term: `pty_${"4242".padStart(32, "0")}`, exitCode: 0, signal: null });
  await settle();
  s.pair.a.close();
  await settle();
  s.procs.calls.length = 0;
  h.kill("SIGKILL");
  assert.equal(killed(s, 4242), false);
});

// The real probe (/proc on Linux), with signals still going to the fake process table: never a real process.
const linuxOnly = process.platform === "linux" ? false : "the default probe reads /proc on Linux only";
function freePid(): number {
  for (let pid = 4_194_303; pid > 1000; pid--) if (!existsSync(`/proc/${pid}`)) return pid;
  throw new Error("no free pid found");
}
function realProbePort() {
  const pair = channelPair();
  const procs = new FakeProcs();
  return { p: createPtyProcessPort({ channel: pair.a, clock: new ManualClock(), ops: procs }), pair, procs };
}

test("real /proc: a reported leader exit whose pid is verifiably free at test time: the group is signalled at dispose", { skip: linuxOnly }, async () => {
  const s = realProbePort();
  const pid = freePid();
  await spawned(s, pid);
  s.pair.b.send({ t: "exit", term: `pty_${String(pid).padStart(32, "0")}`, exitCode: 0, signal: null });
  await settle();
  assert.equal(existsSync(`/proc/${pid}`), false, "still free");
  s.p.dispose();
  assert.equal(killed(s, pid), true);
});

test("real /proc: a reported leader exit whose pid this very process holds: NOT signalled (the id is someone else's)", { skip: linuxOnly }, async () => {
  const s = realProbePort();
  const pid = process.pid;
  await spawned(s, pid);
  s.pair.b.send({ t: "exit", term: `pty_${String(pid).padStart(32, "0")}`, exitCode: 0, signal: null });
  await settle();
  s.p.dispose();
  assert.equal(killed(s, pid), false);
});

test("an exit settled because the channel closed (not reported) leaves the group ours: the direct kill signals it", async () => {
  const s = port(() => true); // even with the pid held: the leader's exit was never reported, so it may be our live leader
  const h = await spawned(s, 4242);
  s.procs.unkillable.add(4242); // survives the close-time kill
  s.pair.a.close();
  await settle();
  s.procs.calls.length = 0;
  h.kill("SIGKILL");
  assert.equal(killed(s, 4242), true);
});
