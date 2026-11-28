// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-3a (terminals-contract.md sections 1 and 8): the capability is all-or-nothing. The handlers register only when the terminal
// port has all four parts (spawn with late reporting, grant, revoke, lateSpawnReports) AND DC-3c's routing is installed and active;
// each handler checks again per call. Every caller but the user's own desktop connection is refused `not_found`.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Handler, HandlerContext } from "@axis/daemon";
import { createTerminalsHandlers, registerTerminalsServing, terminalPortOf, terminalsServable, type TerminalRevocationRouting } from "../../src/terminals/handlers.js";
import { FakeHandle, FakeTerminalPort } from "./fakes.js";
import { serviceRig } from "./service-rig.js";

const on: TerminalRevocationRouting = { active: () => true };
const notFound = (e: unknown): boolean => (e as { code?: unknown }).code === "E_NOT_FOUND";

function withoutPart(part: "spawn" | "grant" | "revoke" | "lateSpawnReports"): unknown {
  const p = new FakeTerminalPort();
  const o: Record<string, unknown> = { spawn: p.spawn.bind(p), grant: p.grant.bind(p), revoke: p.revoke.bind(p), lateSpawnReports: true };
  delete o[part];
  return o;
}

test("servable only with every port part and an active routing", () => {
  assert.equal(terminalsServable(new FakeTerminalPort(), on), true);
  for (const part of ["spawn", "grant", "revoke", "lateSpawnReports"] as const) assert.equal(terminalsServable(withoutPart(part), on), false, `without ${part}`);
  assert.equal(terminalsServable({ ...new FakeTerminalPort(), lateSpawnReports: "yes" }, on), false, "the marker is the literal true");
  assert.equal(terminalsServable(new FakeTerminalPort(), undefined), false, "no routing (DC-3c not installed)");
  assert.equal(terminalsServable(new FakeTerminalPort(), { active: () => false }), false, "a disposed routing");
  assert.equal(terminalsServable(new FakeTerminalPort(), { active: () => { throw new Error("x"); } }), false, "a routing that cannot answer");
  assert.equal(terminalPortOf(undefined), undefined);
});

test("register: nothing is registered unless servable; with every part and an active routing, axis.terminals/1 is", () => {
  const seen: string[] = [];
  const registrar = { register: (c: string, v: number) => void seen.push(`${c}/${v}`) };
  const deps = () => serviceRig().deps;
  for (const part of ["spawn", "grant", "revoke", "lateSpawnReports"] as const) assert.equal(registerTerminalsServing(registrar, withoutPart(part), on, deps), false, part);
  assert.equal(registerTerminalsServing(registrar, new FakeTerminalPort(), undefined, deps), false);
  assert.equal(registerTerminalsServing(registrar, new FakeTerminalPort(), { active: () => false }, deps), false);
  assert.deepEqual(seen, []);
  assert.equal(registerTerminalsServing(registrar, new FakeTerminalPort(), on, deps), true);
  assert.deepEqual(seen, ["axis.terminals/1"]);
});

function call(h: Handler, context: HandlerContext, payload: unknown): Promise<unknown> {
  return Promise.resolve(h(context, payload as never));
}

test("a web, plugin or worker caller is refused not_found by the handler, before anything", async () => {
  const r = serviceRig();
  const handlers = createTerminalsHandlers(r.deps, on);
  const base = r.context();
  for (const [label, identity] of [
    ["web", { ...base.identity, clientKind: "web", windowId: "web" }],
    ["a desktop identity on the web window", { ...base.identity, windowId: "web" }],
    ["plugin", { ...base.identity, clientKind: "plugin", actor: "plugin:x", hostWindowId: "w1" }],
    ["worker", { ...base.identity, actor: "agent:w1" }],
  ] as const) {
    const context = { ...base, identity } as unknown as HandlerContext;
    for (const [m, payload] of [["open", { workspaceId: "ws1", cols: 80, rows: 24 }], ["list", {}], ["close", { terminalId: "pty_0123456789abcdef0123456789abcdef" }], ["attach", { terminalId: "pty_0123456789abcdef0123456789abcdef", conn: "c" }]] as const) {
      await assert.rejects(call(handlers[m], context, payload), notFound, `${label}: ${m}`);
    }
  }
  assert.equal(r.port.spawns.length, 0);
  assert.equal(r.tickets.length, 0);
});

test("once the routing is no longer active every method answers not_found, and open spawns nothing", async () => {
  const r = serviceRig();
  let active = true;
  const handlers = createTerminalsHandlers(r.deps, { active: () => active });
  const p = call(handlers.open, r.context(), { workspaceId: "ws1", cols: 80, rows: 24 });
  for (let i = 0; i < 1000 && r.port.spawns.length === 0; i++) await new Promise((res) => setImmediate(res));
  const h = new FakeHandle();
  r.port.spawns[0]?.resolve(h);
  const out = (await p) as { terminal: { terminalId: string; state: string } };
  assert.deepEqual([out.terminal.terminalId, out.terminal.state], [h.terminalId, "open"]);
  assert.deepEqual(await call(handlers.list, r.context(), {}), { terminals: [{ terminalId: h.terminalId, workspaceId: "ws1", projectId: "p1", kind: "plain", runId: null, state: "open" }] });
  active = false;
  for (const [m, payload] of [["open", { workspaceId: "ws1", cols: 80, rows: 24 }], ["list", {}], ["close", { terminalId: h.terminalId }], ["attach", { terminalId: h.terminalId, conn: "c" }]] as const) {
    await assert.rejects(call(handlers[m], r.context(), payload), notFound, m);
  }
  assert.equal(r.port.spawns.length, 1);
  assert.deepEqual(r.port.grants, []);
});
