// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-3c (terminal-trust-revocation.md sections 6.1 and 8): installTerminalRevocationRouting over the real trust registry. Its
// `active()` is true only between a successful registration and `dispose()`; a source without `onRevoked` gives no routing. A
// recorded revoke reaches the terminals synchronously inside `set`; the audit rows come after the scan, with ids and the level only.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuditEventInput } from "@axis/audit";
import { InMemoryTrustRegistry } from "../../src/policy/trust-registry.js";
import { TerminalRegistry } from "../../src/terminals/registry.js";
import { installTerminalRevocationRouting } from "../../src/terminals/routing.js";
import { FakeHandle, FakeTerminalPort } from "./fakes.js";

function rig() {
  const port = new FakeTerminalPort();
  const registry = new TerminalRegistry({ port });
  const trust = new InMemoryTrustRegistry();
  const audits: AuditEventInput[] = [];
  const open = (windowId = "w1") => {
    const op = registry.reserve("ws1", "p1", windowId);
    assert.ok(op !== undefined);
    const h = new FakeHandle();
    assert.ok(registry.publish(op, h) !== undefined);
    return h;
  };
  return { port, registry, trust, audits, open };
}

test("active() reflects the live subscription: true once installed, false after dispose, and the listener is gone", () => {
  const r = rig();
  const routing = installTerminalRevocationRouting(r.trust, r.registry, (e) => void r.audits.push(e));
  assert.ok(routing !== undefined);
  assert.equal(routing.active(), true);
  routing.dispose();
  assert.equal(routing.active(), false);
  routing.dispose(); // idempotent
  const h = r.open();
  r.trust.set({ windowId: "w1" }, false);
  assert.equal(r.registry.get(h.terminalId)?.state, "open", "a disposed routing reaches nothing");
});

test("a source without onRevoked gives no routing at all", () => {
  const r = rig();
  for (const src of [undefined, null, {}, { onRevoked: "no" }, { isRevoked: () => false }]) assert.equal(installTerminalRevocationRouting(src, r.registry, () => undefined), undefined, JSON.stringify(src));
});

test("a revoke reaches the terminal synchronously inside set; the audit comes after the scan, with ids and the level only", async () => {
  const r = rig();
  installTerminalRevocationRouting(r.trust, r.registry, (e) => void r.audits.push(e));
  const h = r.open("w1");
  r.trust.set({ windowId: "w1" }, false);
  assert.equal(r.registry.get(h.terminalId)?.state, "closed", "already closed when set returns");
  assert.deepEqual(h.kills, ["SIGKILL"]);
  assert.deepEqual(r.audits, [], "the audit is deferred past the scan");
  await Promise.resolve();
  assert.deepEqual((r.audits as AuditEventInput[]).map((a) => [a.action, a.payload]), [["terminal.revoked", { terminalId: h.terminalId, workspaceId: "ws1", projectId: "p1", level: "window", outcome: "closed" }]]);
});

test("a failing audit write changes nothing and is reported, and the rest of the rows are still written", async () => {
  const r = rig();
  const errors: number[] = [];
  let n = 0;
  installTerminalRevocationRouting(r.trust, r.registry, (e) => {
    if (n++ === 0) throw new Error("audit down");
    r.audits.push(e);
  }, () => void errors.push(1));
  const a = r.open("w1");
  const b = r.open("w1");
  r.trust.set({ windowId: "w1" }, false);
  await Promise.resolve();
  assert.equal(errors.length, 1);
  assert.equal(r.audits.length, 1);
  assert.deepEqual([r.registry.get(a.terminalId)?.state, r.registry.get(b.terminalId)?.state], ["closed", "closed"]);
});

test("saturation reaches every terminal (all), through the real registry filled to its bound", () => {
  const r = rig();
  installTerminalRevocationRouting(r.trust, r.registry, () => undefined);
  const h = r.open("w-unrelated");
  for (let i = 0; i < 4096; i++) r.trust.set({ windowId: `g${i}` }, true);
  assert.throws(() => r.trust.set({ windowId: "new" }, false), RangeError);
  assert.equal(r.registry.get(h.terminalId)?.state, "closed");
});
