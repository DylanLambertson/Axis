// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-3c with real control and composition (terminal-trust-revocation.md section 9): the supervisor's `trust.set` over the control
// client reaches the composed terminal registry through the installed routing. A window revoke and a workspace revoke (from another
// window) each close a live terminal and abandon a pending open; saturation through control reaches every terminal; `window.gone`
// abandons that window's pending open and leaves its live terminal running. At shutdown the registry closes what is left.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { GitRunner } from "@axis/git-ops";
import { composeDaemonHost, type ComposeOptions } from "../../src/index.js";
import type { HostTerminals } from "../../src/terminals/compose.js";
import { hostFixture } from "../../testing/host-fixture.js";
import { FakeHandle, FakeTerminalPort } from "./fakes.js";

const runner: GitRunner = { run: () => Promise.reject(new Error("unused")) };
const snapshotter: NonNullable<ComposeOptions["snapshotter"]> = () => ({ before: () => Promise.resolve(), after: () => Promise.resolve({ drift: false }) });
const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

async function host() {
  const fix = hostFixture();
  const { control: _control, ...ports } = fix.ports as typeof fix.ports & { control: unknown };
  let terminals: HostTerminals | undefined;
  const composed = composeDaemonHost({ config: fix.config, control: fix.client, ports, pty: new FakeTerminalPort(), ptyGitRunner: runner, snapshotter, process: new EventEmitter(), exit: () => undefined, observeTerminals: (t) => void (terminals = t) });
  await composed.start();
  assert.ok(terminals !== undefined);
  const reg = terminals.registry;
  const open = (ws: string, windowId: string) => {
    const op = reg.reserve(ws, "p1", windowId);
    assert.ok(op !== undefined);
    const h = new FakeHandle();
    assert.ok(reg.publish(op, h) !== undefined);
    return h;
  };
  const pending = (ws: string, windowId: string) => {
    const op = reg.reserve(ws, "p1", windowId);
    assert.ok(op !== undefined);
    return op;
  };
  const stop = async () => (await composed.stop(), fix.cleanup());
  return { fix, reg, open, pending, stop };
}

for (const [label, message] of [
  ["a window revoke", { type: "trust.set", windowId: "w1", trusted: false }],
  ["a workspace revoke from another window", { type: "trust.set", windowId: "w9", workspaceId: "ws1", trusted: false }],
] as const) {
  test(`${label} over the control client closes the live terminal and abandons the pending open`, async (t) => {
    const h = await host();
    t.after(h.stop);
    const live = h.open("ws1", "w1");
    const op = h.pending("ws1", "w1");
    const other = h.open("ws2", "w2");
    h.fix.peer.send(message);
    await settle();
    assert.equal(h.reg.get(live.terminalId)?.state, "closed");
    assert.deepEqual(live.kills, ["SIGKILL"]);
    const late = new FakeHandle();
    assert.equal(h.reg.publish(op, late), undefined, "the pending open's late handle is never published");
    assert.equal(h.reg.get(other.terminalId)?.state, "open", "unreached");
  });
}

test("saturation through control reaches every terminal", async (t) => {
  const h = await host();
  t.after(h.stop);
  const live = h.open("ws1", "w-x");
  for (let i = 0; i < 4096; i++) h.fix.peer.send({ type: "trust.set", windowId: `g${i}`, trusted: true });
  await settle();
  h.fix.peer.send({ type: "trust.set", windowId: "new", trusted: false });
  await settle();
  assert.equal(h.reg.get(live.terminalId)?.state, "closed");
});

test("window.gone over the control client abandons that window's pending open; its live terminal keeps running", async (t) => {
  const h = await host();
  t.after(h.stop);
  const live = h.open("ws1", "w1");
  const op = h.pending("ws1", "w1");
  h.fix.peer.send({ type: "window.gone", windowId: "w1" });
  await settle();
  assert.equal(h.reg.publish(op, new FakeHandle()), undefined);
  assert.equal(h.reg.get(live.terminalId)?.state, "open");
});

test("shutdown closes the live plain terminals", async () => {
  const h = await host();
  const live = h.open("ws1", "w1");
  await h.stop();
  assert.equal(h.reg.get(live.terminalId)?.state, "closed");
  assert.deepEqual(live.kills, ["SIGKILL"]);
});
