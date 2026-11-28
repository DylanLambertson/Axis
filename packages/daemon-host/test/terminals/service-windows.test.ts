// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-3c (terminal-trust-revocation.md section 3) through the service: `open` records the caller's window and `attach` records the
// attaching window, so a revoke of either window, routed by the installed routing, reaches the terminal.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HandlerContext } from "@axis/daemon";
import { installTerminalRevocationRouting } from "../../src/terminals/routing.js";
import { attachTerminal, openTerminal } from "../../src/terminals/service.js";
import { FakeHandle } from "./fakes.js";
import { serviceRig } from "./service-rig.js";

async function opened() {
  const r = serviceRig();
  installTerminalRevocationRouting(r.trust, r.registry, () => undefined);
  const p = openTerminal(r.deps, { workspaceId: "ws1", cols: 80, rows: 24 }, r.context());
  for (let i = 0; i < 1000 && r.port.spawns.length === 0; i++) await new Promise((res) => setImmediate(res));
  const h = new FakeHandle();
  r.port.spawns[0]?.resolve(h);
  const rec = await p;
  return { r, h, id: rec.terminalId };
}

test("a revoke of the window that opened it (the caller's) reaches the terminal", async () => {
  const { r, id } = await opened();
  r.trust.set({ windowId: "w1" }, false);
  assert.equal(r.registry.get(id)?.state, "closed");
});

test("a revoke of a window that attached it reaches the terminal; one that never did, does not", async () => {
  const { r, id } = await opened();
  const other = r.context();
  attachTerminal(r.deps, id, "c5", { ...other, identity: { ...other.identity, windowId: "w5" } } as unknown as HandlerContext);
  r.trust.set({ windowId: "w7" }, false);
  assert.equal(r.registry.get(id)?.state, "open", "w7 never opened or attached it");
  r.trust.set({ windowId: "w5" }, false);
  assert.equal(r.registry.get(id)?.state, "closed");
});
