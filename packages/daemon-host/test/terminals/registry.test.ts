// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-3a (terminals-contract.md section 4): the daemon's terminal registry. Slots are reserved before the spawn and released only on
// a definitive no-spawn or when the group is known gone; a terminal's lifecycle is monotonic (open, closing, closed or exited);
// `close` revokes the grant before the kill; a handle for an abandoned open is never published; a project event abandons the
// project's pending opens and closes its live plain terminals.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TerminalRegistry, type TerminalOp } from "../../src/terminals/registry.js";
import { FakeHandle, FakeTerminalPort, spawnError } from "./fakes.js";

function rig(max = 8) {
  const port = new FakeTerminalPort();
  const reg = new TerminalRegistry({ port, maxPerWorkspace: max });
  const op = (ws = "ws1", project = "p1"): TerminalOp => {
    const o = reg.reserve(ws, project);
    assert.ok(o !== undefined, "a slot");
    return o;
  };
  const open = (ws = "ws1", project = "p1") => {
    const h = new FakeHandle();
    const rec = reg.publish(op(ws, project), h);
    assert.ok(rec !== undefined);
    return { h, rec };
  };
  return { port, reg, op, open };
}

test("at most 8 per workspace, pending and live together: with 7 records two reservations make 8, never 9", () => {
  const r = rig();
  for (let i = 0; i < 7; i++) r.open();
  const a = r.reg.reserve("ws1", "p1");
  const b = r.reg.reserve("ws1", "p1");
  assert.ok(a !== undefined);
  assert.equal(b, undefined, "the ninth is refused");
  assert.ok(r.reg.reserve("ws2", "p1") !== undefined, "another workspace has its own slots");
});

test("a definitive failure releases the slot; a timeout keeps it charged until its late outcome", () => {
  const r = rig(1);
  const a = r.op();
  r.reg.failed(a, spawnError("spawn_failed", true));
  const b = r.op();
  r.reg.failed(b, spawnError("timeout", false));
  assert.equal(r.reg.reserve("ws1", "p1"), undefined, "unknown stays charged");
  r.reg.late(b, { kind: "failed", code: "capacity" });
  assert.ok(r.reg.reserve("ws1", "p1") !== undefined, "the late definitive no-spawn releases it");
});

test("a late group is tracked: its slot stays charged until the group is gone, and it is never published", () => {
  const r = rig(1);
  const a = r.op();
  r.reg.failed(a, spawnError("timeout", false));
  const h = new FakeHandle();
  h.survives = true;
  r.reg.late(a, { kind: "spawned", handle: h });
  assert.deepEqual(r.port.revokes, [h.terminalId], "revoked");
  assert.deepEqual(h.kills, ["SIGKILL"], "killed");
  assert.equal(r.reg.list().length, 0, "never published");
  assert.equal(r.reg.reserve("ws1", "p1"), undefined, "the surviving group keeps the slot");
  h.alive = false;
  assert.ok(r.reg.reserve("ws1", "p1") !== undefined, "released once the group is gone");
});

test("a spawn that answers for an abandoned open is revoked, killed and tracked, never published", () => {
  const r = rig(1);
  const a = r.op();
  r.reg.abandon(a);
  const h = new FakeHandle();
  h.killThrows = true;
  assert.equal(r.reg.publish(a, h), undefined);
  assert.deepEqual(r.port.revokes, [h.terminalId]);
  assert.equal(r.reg.list().length, 0);
  assert.equal(r.reg.reserve("ws1", "p1"), undefined, "charged while the group lives");
  h.alive = false;
  assert.ok(r.reg.reserve("ws1", "p1") !== undefined);
});

test("a handle that is not valid is not published; it is killed and its slot stays charged (it cannot be tracked)", () => {
  const r = rig(1);
  const a = r.op();
  const bad = new FakeHandle("not-a-terminal-id");
  assert.equal(r.reg.publish(a, bad), undefined);
  assert.deepEqual(bad.kills, ["SIGKILL"]);
  bad.alive = false;
  assert.equal(r.reg.reserve("ws1", "p1"), undefined, "an id that cannot be checked keeps the slot");
});

test("close: closing first, then the revoke, then the kill; repeated close keeps the state; attach is refused from closing on", () => {
  const r = rig();
  const { h, rec } = r.open();
  const order: string[] = [];
  r.port.revoke = (id) => (order.push(`revoke:${r.reg.get(id)?.state}`), true);
  const kill = h.kill.bind(h);
  h.kill = (s) => (order.push(`kill:${r.reg.get(rec.terminalId)?.state}`), kill(s));
  assert.ok(r.reg.attachable(rec.terminalId) !== undefined, "open: attachable");
  assert.equal(r.reg.close(rec.terminalId), true);
  assert.deepEqual(order, ["revoke:closing", "kill:closing"]);
  assert.equal(r.reg.get(rec.terminalId)?.state, "closed");
  assert.equal(r.reg.close(rec.terminalId), true, "idempotent");
  assert.equal(r.reg.get(rec.terminalId)?.state, "closed");
  assert.equal(r.reg.attachable(rec.terminalId), undefined);
});

test("a kill that throws leaves the terminal closing, never attachable again, and its slot charged while the group lives", () => {
  const r = rig(1);
  const { h, rec } = r.open();
  h.killThrows = true;
  assert.equal(r.reg.close(rec.terminalId), true);
  assert.equal(r.reg.get(rec.terminalId)?.state, "closing");
  assert.equal(r.reg.attachable(rec.terminalId), undefined);
  assert.equal(r.reg.reserve("ws1", "p1"), undefined);
  h.exit(); // the leader's exit after a close does not reopen anything
  assert.equal(r.reg.get(rec.terminalId)?.state, "closed");
  assert.equal(r.reg.attachable(rec.terminalId), undefined);
});

test("a leader that exits with a surviving child: exited, revoked, slot charged until the group is gone, then forgotten", () => {
  const r = rig(1);
  const { h, rec } = r.open();
  h.exit(false);
  assert.equal(r.reg.get(rec.terminalId)?.state, "exited");
  assert.deepEqual(r.port.revokes, [rec.terminalId], "revoked at the leader's exit");
  assert.equal(r.reg.attachable(rec.terminalId), undefined, "no re-grant after a natural exit");
  assert.equal(r.reg.reserve("ws1", "p1"), undefined, "the surviving child keeps the slot");
  h.alive = false;
  assert.ok(r.reg.reserve("ws1", "p1") !== undefined);
  assert.equal(r.reg.get(rec.terminalId), undefined, "an ended terminal whose group is gone is forgotten");
});

test("a liveness check that throws keeps the slot charged (unknown counts as alive)", () => {
  const r = rig(1);
  const { h, rec } = r.open();
  r.reg.close(rec.terminalId);
  h.alive = false;
  h.probeThrows = true;
  assert.equal(r.reg.reserve("ws1", "p1"), undefined);
  h.probeThrows = false;
  assert.ok(r.reg.reserve("ws1", "p1") !== undefined);
});

test("a CLI run's terminal is listed and attachable, but close refuses it and it holds no plain slot", () => {
  const r = rig(1);
  const h = new FakeHandle();
  r.reg.addCliRun(h, { runId: "run1", workspaceId: "ws1", projectId: "p1" });
  assert.deepEqual(r.reg.list().map((t) => [t.kind, t.runId]), [["cli-run", "run1"]]);
  assert.ok(r.reg.attachable(h.terminalId) !== undefined);
  assert.equal(r.reg.close(h.terminalId), false);
  assert.ok(r.reg.reserve("ws1", "p1") !== undefined, "a run's terminal is not a plain slot");
  h.exit(true);
  assert.equal(r.reg.attachable(h.terminalId), undefined, "exited");
  r.reg.sweep();
  assert.equal(r.reg.get(h.terminalId), undefined, "dropped once its group is gone");
});

test("a project event abandons the project's pending opens and closes its live plain terminals; others are untouched", () => {
  const r = rig();
  const live = r.open("ws1", "p1");
  const other = r.open("ws9", "p9");
  const pending = r.op("ws1", "p1");
  const run = new FakeHandle();
  r.reg.addCliRun(run, { runId: "run1", workspaceId: "ws1", projectId: "p1" });
  r.reg.projectRevoked("p1");
  assert.equal(r.reg.get(live.rec.terminalId)?.state, "closed");
  assert.deepEqual(live.h.kills, ["SIGKILL"]);
  assert.equal(r.reg.get(other.rec.terminalId)?.state, "open");
  const late = new FakeHandle();
  assert.equal(r.reg.publish(pending, late), undefined, "the pending open's handle is never published");
  assert.deepEqual(late.kills, ["SIGKILL"]);
  assert.equal(r.reg.get(run.terminalId)?.state, "open", "a run's terminal is ended by the run's own stop, not here");
});

test("list filters by workspace and never shows a pending open", () => {
  const r = rig();
  r.open("ws1");
  r.open("ws2");
  r.op("ws1");
  assert.equal(r.reg.list().length, 2);
  assert.deepEqual(r.reg.list("ws2").map((t) => t.workspaceId), ["ws2"]);
});
