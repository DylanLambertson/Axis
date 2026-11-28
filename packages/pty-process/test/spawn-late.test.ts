// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-3a (terminals-contract.md section 4): the pty client tells its own response timeout apart from a definitive outcome, and keeps
// a spawn's identity through a late answer. A rejection says whether it is `definitive` (the pty process's `spawn-failed`, or a
// refusal before anything was sent) or not (the client's timeout, or a channel that closed with the request in flight). A
// `spawned` that arrives after the timeout is still killed, and its group is now also tracked and handed to the spawn's `onLate`, so
// the caller can keep its slot charged until the group is gone. A late `spawn-failed` is handed over too: that is the definitive
// "no spawn". An answer to a request this port never made is only killed, as before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPtyProcessPort, PtySpawnError, type LateSpawn } from "../src/index.js";
import { channelPair, FakeProcs, ManualClock, settle } from "../testing/helpers.js";
import { rig, SPEC } from "../testing/rig.js";

const err = (e: unknown): PtySpawnError => {
  assert.ok(e instanceof PtySpawnError);
  return e;
};

function silentPort(extra: { maxPending?: number } = {}) {
  const pair = channelPair(); // nothing serves pair.b: answers are scripted by the test
  const clock = new ManualClock();
  const procs = new FakeProcs();
  return { port: createPtyProcessPort({ channel: pair.a, clock, ops: procs, ...extra }), pair, clock, procs };
}
const reqOf = (sent: unknown[]): string => (sent.at(-1) as { req: string }).req;

test("a timeout is not definitive; the pty process's spawn-failed is", async () => {
  const s = silentPort();
  const p = s.port.spawn(SPEC);
  s.clock.fire();
  const timedOut = err(await p.catch((e: unknown) => e));
  assert.deepEqual([timedOut.code, timedOut.definitive], ["timeout", false]);
  const q = s.port.spawn(SPEC);
  s.pair.b.send({ t: "spawn-failed", req: reqOf(s.pair.sent.a), code: "spawn_failed" });
  const failed = err(await q.catch((e: unknown) => e));
  assert.deepEqual([failed.code, failed.definitive], ["spawn_failed", true]);
});

test("a refusal before anything is sent is definitive; a channel closing with the request in flight is not", async () => {
  const s = silentPort({ maxPending: 1 });
  const inFlight = s.port.spawn(SPEC);
  const capacity = err(await s.port.spawn(SPEC).catch((e: unknown) => e));
  assert.deepEqual([capacity.code, capacity.definitive], ["capacity", true]);
  s.pair.b.close();
  const closed = err(await inFlight.catch((e: unknown) => e));
  assert.deepEqual([closed.code, closed.definitive], ["channel_closed", false]);
  const after = err(await s.port.spawn(SPEC).catch((e: unknown) => e));
  assert.deepEqual([after.code, after.definitive], ["channel_closed", true]);
});

test("a spawned answer after the timeout is killed, tracked, and handed to onLate with the spawn's own identity", async () => {
  const s = silentPort();
  const lates: LateSpawn[] = [];
  const p = s.port.spawn(SPEC, (l) => lates.push(l));
  const req = reqOf(s.pair.sent.a);
  s.clock.fire();
  await p.catch(() => undefined);
  s.procs.live.add(4242);
  s.procs.unkillable.add(4242); // the kill does not end the group
  s.pair.b.send({ t: "spawned", req, term: "pty_late", group: { kind: "pgid", pgid: 4242 } });
  await settle();
  assert.deepEqual(s.pair.sent.a.slice(-2), [{ t: "revoke", term: "pty_late" }, { t: "kill", term: "pty_late", signal: "SIGKILL" }], "revoked, then killed");
  assert.equal(lates.length, 1);
  const late = lates[0];
  assert.ok(late?.kind === "spawned");
  assert.equal(late.handle.terminalId, "pty_late");
  assert.equal(late.handle.groupAlive(), true, "the surviving group is visible");
  assert.equal(s.port.trackedTerminals(), 1, "the port tracks it");
  // once the group is gone and the leader's exit is known, the handle says so
  s.procs.unkillable.delete(4242);
  s.procs.live.delete(4242);
  assert.equal(late.handle.groupAlive(), false);
});

test("a late spawn-failed is handed to onLate: the definitive no-spawn", async () => {
  const s = silentPort();
  const lates: LateSpawn[] = [];
  const p = s.port.spawn(SPEC, (l) => lates.push(l));
  const req = reqOf(s.pair.sent.a);
  s.clock.fire();
  await p.catch(() => undefined);
  s.pair.b.send({ t: "spawn-failed", req, code: "capacity" });
  await settle();
  assert.deepEqual(lates, [{ kind: "failed", code: "capacity" }]);
});

test("each late answer is handed over once; an answer to a request never made is killed and not tracked", async () => {
  const s = silentPort();
  const lates: LateSpawn[] = [];
  const p = s.port.spawn(SPEC, (l) => lates.push(l));
  const req = reqOf(s.pair.sent.a);
  s.clock.fire();
  await p.catch(() => undefined);
  s.procs.live.add(4242);
  s.pair.b.send({ t: "spawned", req, term: "pty_late", group: { kind: "pgid", pgid: 4242 } });
  s.pair.b.send({ t: "spawned", req, term: "pty_again", group: { kind: "pgid", pgid: 4243 } });
  s.pair.b.send({ t: "spawned", req: "r999", term: "pty_unknown", group: { kind: "pgid", pgid: 4244 } });
  await settle();
  assert.equal(lates.length, 1);
  assert.deepEqual(s.pair.sent.a.slice(-4), [{ t: "revoke", term: "pty_again" }, { t: "kill", term: "pty_again", signal: "SIGKILL" }, { t: "revoke", term: "pty_unknown" }, { t: "kill", term: "pty_unknown", signal: "SIGKILL" }]);
  assert.equal(s.port.trackedTerminals(), 1);
});

test("a throwing onLate does not stop the kill or the tracking", async () => {
  const s = silentPort();
  const p = s.port.spawn(SPEC, () => {
    throw new Error("listener");
  });
  const req = reqOf(s.pair.sent.a);
  s.clock.fire();
  await p.catch(() => undefined);
  s.procs.live.add(4242);
  s.pair.b.send({ t: "spawned", req, term: "pty_late", group: { kind: "pgid", pgid: 4242 } });
  await settle();
  assert.deepEqual(s.pair.sent.a.at(-1), { t: "kill", term: "pty_late", signal: "SIGKILL" });
  assert.equal(s.port.trackedTerminals(), 1);
});

test("with the real service: a spawned answer delayed past the timeout, whose group survives the kill, stays tracked", async () => {
  const r = rig();
  const lates: LateSpawn[] = [];
  const p = r.port.spawn(SPEC, (l) => lates.push(l));
  r.clock.fire(); // the client's bound fires before the service's answer is delivered
  const e = err(await p.catch((x: unknown) => x));
  assert.equal(e.definitive, false);
  const child = r.children[0];
  assert.ok(child !== undefined, "the service did spawn");
  r.procs.unkillable.add(child.pid);
  await settle();
  const late = lates[0];
  assert.ok(late?.kind === "spawned", JSON.stringify(lates));
  assert.ok(r.procs.calls.some(([pid, sig]) => pid === -child.pid && sig === "SIGKILL"), "killed");
  assert.equal(late.handle.groupAlive(), true, "the group survived and is still charged");
  // Review nit 1: the service revoked it before the kill, so a grant to it (a stale or a mistaken one) gives no data connection access.
  const data = channelPair();
  r.service.serveData(data.b, "c1");
  r.port.grantTerminal(late.handle.terminalId, "c1");
  await settle();
  data.a.send({ t: "attach", term: late.handle.terminalId });
  await settle();
  assert.deepEqual(data.sent.b.at(-1), { t: "refused", term: null, code: "foreign_terminal" });
});

test("the port can revoke a terminal; a closed port sends nothing", () => {
  const s = silentPort();
  assert.equal(s.port.revoke("pty_1"), true);
  assert.deepEqual(s.pair.sent.a.at(-1), { t: "revoke", term: "pty_1" });
  s.port.dispose();
  assert.equal(s.port.revoke("pty_1"), false);
});

test("review S1: dispose settles every tracked terminal's exit (unknown), as a channel close does, so its owner can end it", async () => {
  const r = rig();
  const h = await r.port.spawn(SPEC);
  const exits: unknown[] = [];
  h.onExit((e) => exits.push(e));
  r.port.dispose();
  await settle();
  assert.deepEqual(exits, [{ exitCode: null, signal: null }]);
  assert.equal(r.port.trackedTerminals(), 0);
});
