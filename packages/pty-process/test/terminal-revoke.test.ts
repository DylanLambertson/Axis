// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-3a (terminals-contract.md section 5): revoking one terminal's grant. A `revoke` clears the grant and detaches the owner for
// good: the viewer is told the terminal ended, receives none of its later output, and its attach, write and resize are refused. A
// leader's exit revokes the same way inside the service, even while a child of its group survives. A grant that arrives after
// either (a stale one already in flight) cannot reactivate the terminal. The shared data connection itself stays open, and its other
// terminals are unaffected. While a terminal is open, moving it between data connections works as before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { controlRequest } from "../src/index.js";
import { channelPair, settle } from "../testing/helpers.js";
import { rig, SPEC } from "../testing/rig.js";

const refused = { t: "refused", term: null, code: "foreign_terminal" };

/** Two terminals granted to one data connection `c1` and attached by it. */
async function twoAttached(opts: Parameters<typeof rig>[0] = {}) {
  const r = rig(opts);
  const a = await r.port.spawn(SPEC);
  const b = await r.port.spawn({ ...SPEC, runId: "run2" });
  const data = channelPair();
  r.service.serveData(data.b, "c1");
  r.port.grantTerminal(a.terminalId, "c1");
  r.port.grantTerminal(b.terminalId, "c1");
  await settle();
  data.a.send({ t: "attach", term: a.terminalId });
  data.a.send({ t: "attach", term: b.terminalId });
  await settle();
  assert.deepEqual(data.sent.b.slice(-2), [{ t: "attached", term: a.terminalId }, { t: "attached", term: b.terminalId }]);
  const [ca, cb] = r.children;
  assert.ok(ca !== undefined && cb !== undefined);
  return { r, a, b, data, ca, cb };
}

/** After an end of access: the viewer's attach, write and resize of `term` are refused, and output of it no longer arrives. */
async function locked(h: Awaited<ReturnType<typeof twoAttached>>, term: string, child: { emit(c: string): void; written: string[]; resized: Array<[number, number]> }) {
  const mark = h.data.sent.b.length;
  child.emit("after the end");
  await settle();
  assert.ok(!h.data.sent.b.slice(mark).some((m) => (m as { t: string }).t === "data"), "no later output");
  for (const m of [{ t: "attach", term }, { t: "write", term, data: "x" }, { t: "resize", term, cols: 10, rows: 5 }]) {
    h.data.a.send(m);
    await settle();
    assert.deepEqual(h.data.sent.b.at(-1), refused, `${m.t} refused`);
  }
  assert.deepEqual(child.written, [], "nothing written");
  assert.deepEqual(child.resized, [], "nothing resized");
}

/** The other terminal on the same data connection still works. */
async function otherWorks(h: Awaited<ReturnType<typeof twoAttached>>) {
  h.cb.emit("still here");
  await settle();
  const last = h.data.sent.b.at(-1) as { t: string; term: string; chunk: string };
  assert.deepEqual([last.t, last.term, last.chunk.endsWith("still here")], ["data", h.b.terminalId, true], "the other terminal's output");
  h.data.a.send({ t: "write", term: h.b.terminalId, data: "y" });
  await settle();
  assert.deepEqual(h.cb.written, ["y"]);
}

test("the control schema has a revoke message for one terminal, and nothing more on it", () => {
  assert.equal(controlRequest.safeParse({ t: "revoke", term: "pty_1" }).success, true);
  assert.equal(controlRequest.safeParse({ t: "revoke", term: "pty_1", conn: "c1" }).success, false);
  assert.equal(controlRequest.safeParse({ t: "revoke" }).success, false);
});

test("revoke: the attached viewer is told the terminal ended, gets no later output, and cannot attach, write or resize it", async () => {
  const h = await twoAttached();
  assert.equal(h.r.port.revoke(h.a.terminalId), true);
  await settle();
  assert.deepEqual(h.data.sent.b.at(-1), { t: "exit", term: h.a.terminalId });
  await locked(h, h.a.terminalId, h.ca);
  await otherWorks(h);
});

test("revoke holds while the group survives a kill (the kill comes after the revoke, and may fail)", async () => {
  const h = await twoAttached();
  h.r.procs.unkillable.add(h.ca.pid);
  h.r.port.revoke(h.a.terminalId);
  h.a.kill("SIGKILL");
  await settle();
  assert.equal(h.a.groupAlive(), true, "the group survived");
  await locked(h, h.a.terminalId, h.ca);
});

test("revoke holds when the kill after it throws (the signal is refused)", async () => {
  const h = await twoAttached();
  h.r.port.revoke(h.a.terminalId);
  h.r.procs.failWith = "EPERM"; // every signal and probe now throws
  const mark = h.r.procs.calls.length;
  h.a.kill("SIGKILL");
  await settle();
  assert.ok(h.r.procs.calls.slice(mark).some(([pid]) => pid === -h.ca.pid), "the kill was attempted, and threw");
  h.r.procs.failWith = undefined;
  assert.ok(h.r.procs.live.has(h.ca.pid), "the group is still there");
  await locked(h, h.a.terminalId, h.ca);
  await otherWorks(h);
});

test("a grant after a revoke (a stale one in flight) cannot reactivate the terminal", async () => {
  const h = await twoAttached();
  h.r.port.revoke(h.a.terminalId);
  h.r.port.grantTerminal(h.a.terminalId, "c1");
  await settle();
  await locked(h, h.a.terminalId, h.ca);
  // a fresh data connection named in a later grant gets nothing either
  const other = channelPair();
  h.r.service.serveData(other.b, "c2");
  h.r.port.grantTerminal(h.a.terminalId, "c2");
  await settle();
  other.a.send({ t: "attach", term: h.a.terminalId });
  await settle();
  assert.deepEqual(other.sent.b.at(-1), refused);
});

test("a leader's exit revokes inside the service while a child of its group survives", async () => {
  const h = await twoAttached();
  h.ca.exit({ exitCode: 0, signal: null }); // the group (pgid) is still live in the fake process table
  await settle();
  assert.ok(h.r.procs.live.has(h.ca.pid), "a child of the group survives");
  assert.deepEqual(h.data.sent.b.at(-1), { t: "exit", term: h.a.terminalId });
  await locked(h, h.a.terminalId, h.ca);
  // and a re-grant after the exit is refused as well
  h.r.port.grantTerminal(h.a.terminalId, "c1");
  await settle();
  h.data.a.send({ t: "attach", term: h.a.terminalId });
  await settle();
  assert.deepEqual(h.data.sent.b.at(-1), refused, "re-grant after a natural exit");
  await otherWorks(h);
});

test("revoking twice, or a terminal that is unknown, changes nothing else", async () => {
  const h = await twoAttached();
  h.r.port.revoke(h.a.terminalId);
  await settle();
  const mark = h.data.sent.b.length;
  h.r.port.revoke(h.a.terminalId);
  h.r.port.revoke("pty_ffffffffffffffffffffffffffffffff");
  await settle();
  assert.equal(h.data.sent.b.length, mark, "no second exit");
  await otherWorks(h);
});

test("while a terminal is open, moving it to another data connection still works", async () => {
  const h = await twoAttached();
  const other = channelPair();
  h.r.service.serveData(other.b, "c2");
  h.r.port.grantTerminal(h.a.terminalId, "c2");
  await settle();
  other.a.send({ t: "attach", term: h.a.terminalId });
  await settle();
  assert.deepEqual(other.sent.b.at(-1), { t: "attached", term: h.a.terminalId });
  other.a.send({ t: "write", term: h.a.terminalId, data: "z" });
  await settle();
  assert.deepEqual(h.ca.written, ["z"]);
});
