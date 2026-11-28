// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-3c (terminal-trust-revocation.md sections 3 and 4.1): which terminals a revoke reaches, and what it does to them. A terminal
// remembers the window that opened it and every window that attached it (at most 8, then any window reaches it). A window revoke
// reaches those; a subject revoke reaches every terminal whose workspace or project it names; `all` reaches every terminal. Three
// passes: authority is lowered for ALL reached records first (pending abandoned, open plain closing, revoked), then the kills, and
// each step for each record is caught on its own. A CLI run's terminal is revoked and stays running, never attachable again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TerminalRegistry } from "../../src/terminals/registry.js";
import { FakeHandle, FakeTerminalPort } from "./fakes.js";

function rig() {
  const port = new FakeTerminalPort();
  const reg = new TerminalRegistry({ port });
  const open = (ws: string, project: string, windowId: string) => {
    const op = reg.reserve(ws, project, windowId);
    assert.ok(op !== undefined);
    const h = new FakeHandle();
    const rec = reg.publish(op, h);
    assert.ok(rec !== undefined);
    return { h, id: rec.terminalId };
  };
  return { port, reg, open };
}

test("a window revoke reaches the terminals that window opened or attached, and no other", () => {
  const r = rig();
  const a = r.open("ws1", "p1", "w1");
  const b = r.open("ws1", "p1", "w2");
  r.reg.noteWindow(b.id, "w1"); // w1 attached b
  const c = r.open("ws1", "p1", "w3");
  const out = r.reg.revoked({ kind: "window", windowId: "w1" });
  assert.deepEqual(out.map((o) => [o.terminalId, o.outcome]).sort(), [[a.id, "closed"], [b.id, "closed"]].sort());
  assert.equal(r.reg.get(c.id)?.state, "open", "a window that never opened or attached it does not reach it");
});

test("a subject revoke reaches by workspace and by project, through any window", () => {
  const r = rig();
  const a = r.open("ws1", "p1", "w1");
  const b = r.open("ws2", "p1", "w2");
  const c = r.open("ws3", "p9", "w3");
  assert.deepEqual(r.reg.revoked({ kind: "subject", id: "ws1" }).map((o) => o.terminalId), [a.id]);
  assert.deepEqual(r.reg.revoked({ kind: "subject", id: "p1" }).map((o) => o.terminalId), [b.id], "a is already ended: nothing twice");
  assert.equal(r.reg.get(c.id)?.state, "open");
});

test("all reaches every terminal, pending ones included", () => {
  const r = rig();
  const a = r.open("ws1", "p1", "w1");
  const pending = r.reg.reserve("ws2", "p2", "w2");
  assert.ok(pending !== undefined);
  const out = r.reg.revoked({ kind: "all" });
  assert.deepEqual(out.map((o) => o.outcome).sort(), ["abandoned", "closed"]);
  const late = new FakeHandle();
  assert.equal(r.reg.publish(pending, late), undefined, "the pending open's handle is never published");
  assert.deepEqual(late.kills, ["SIGKILL"]);
  assert.equal(r.reg.get(a.id)?.state, "closed");
});

test("a ninth attaching window marks the terminal reached by any window revoke", () => {
  const r = rig();
  const a = r.open("ws1", "p1", "w0");
  for (let i = 1; i <= 8; i++) r.reg.noteWindow(a.id, `w${i}`);
  assert.deepEqual(r.reg.revoked({ kind: "window", windowId: "never-seen" }).map((o) => o.terminalId), [a.id]);
});

test("three passes: every reached record loses authority before any kill, and a throwing revoke or kill never stops another", () => {
  const r = rig();
  const t1 = r.open("ws1", "p1", "w1");
  const t3 = r.open("ws1", "p1", "w1");
  const t2 = r.reg.reserve("ws1", "p1", "w1");
  assert.ok(t2 !== undefined);
  const order: string[] = [];
  r.port.revoke = (id) => {
    order.push(`revoke:${id === t1.id ? "t1" : "t3"}`);
    if (id === t1.id) throw new Error("revoke fails for t1");
    return true;
  };
  t1.h.killThrows = true;
  const kill3 = t3.h.kill.bind(t3.h);
  t3.h.kill = (s) => (order.push(`kill:t3:${r.reg.get(t1.id)?.state}`), kill3(s));
  const out = r.reg.revoked({ kind: "window", windowId: "w1" });
  assert.deepEqual(order, ["revoke:t1", "revoke:t3", "kill:t3:closing"], "both revokes before the first kill; t1 is closing by then");
  assert.equal(r.reg.get(t1.id)?.state, "closing", "t1's kill threw: it stays closing, never attachable");
  assert.equal(r.reg.attachable(t1.id), undefined);
  assert.equal(r.reg.get(t3.id)?.state, "closed");
  assert.equal(out.length, 3);
  assert.equal(r.reg.publish(t2, new FakeHandle()), undefined, "t2, pending, was abandoned despite t1's failures");
});

test("a CLI run's terminal reached by a revoke is revoked, keeps running, and is never attachable again", () => {
  const r = rig();
  const run = new FakeHandle();
  r.reg.addCliRun(run, { runId: "run1", workspaceId: "ws1", projectId: "p1" });
  r.reg.noteWindow(run.terminalId, "w1");
  const out = r.reg.revoked({ kind: "subject", id: "ws1" });
  assert.deepEqual(out.map((o) => [o.terminalId, o.outcome]), [[run.terminalId, "grant_revoked"]]);
  assert.deepEqual(r.port.revokes, [run.terminalId]);
  assert.deepEqual(run.kills, [], "the run keeps running (Q6)");
  assert.equal(r.reg.attachable(run.terminalId), undefined);
  assert.equal(r.reg.revoked({ kind: "subject", id: "ws1" }).length, 0, "a repeated revoke reaches nothing new");
});

test("window.gone abandons that window's pending opens only; live terminals keep running (a terminal outlives its window)", () => {
  const r = rig();
  const live = r.open("ws1", "p1", "w1");
  const mine = r.reg.reserve("ws1", "p1", "w1");
  const other = r.reg.reserve("ws1", "p1", "w2");
  assert.ok(mine !== undefined && other !== undefined);
  r.reg.windowGone("w1");
  const late = new FakeHandle();
  assert.equal(r.reg.publish(mine, late), undefined, "the gone window's pending open is never published");
  assert.deepEqual(late.kills, ["SIGKILL"]);
  assert.ok(r.reg.publish(other, new FakeHandle()) !== undefined, "another window's open is unaffected");
  assert.equal(r.reg.get(live.id)?.state, "open", "a live terminal stays: another window re-attaches it");
});

test("shutdown: pending opens abandoned, live plain terminals closed (revoked, killed); a CLI run's terminal ends with its run", () => {
  const r = rig();
  const live = r.open("ws1", "p1", "w1");
  const pending = r.reg.reserve("ws1", "p1", "w1");
  assert.ok(pending !== undefined);
  const run = new FakeHandle();
  r.reg.addCliRun(run, { runId: "run1", workspaceId: "ws1", projectId: "p1" });
  r.reg.shutdown();
  assert.equal(r.reg.get(live.id)?.state, "closed");
  assert.deepEqual(live.h.kills, ["SIGKILL"]);
  assert.equal(r.reg.publish(pending, new FakeHandle()), undefined);
  assert.deepEqual(run.kills, []);
});
