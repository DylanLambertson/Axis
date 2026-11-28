// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// DC-3a (terminals-contract.md section 2): `open` resolves the workspace through the locator, admits through the trust gate, checks
// the locator and the binding again, then one synchronous final admission (trust and binding identity now, the registry's
// revocations, READY, path and lock identity, cancellation), the slot, the ticket and the dispatch with the locator's path as `cwd`.
// Each change timed inside the gate's await is refused before any spawn; a cancellation or a project event while the spawn is
// pending never publishes its handle.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project, Workspace } from "@axis/journal";
import { spendTicket } from "../../src/gate/project-ticket.js";
import { openTerminal } from "../../src/terminals/service.js";
import { FakeHandle, spawnError } from "./fakes.js";
import { serviceRig, WT } from "./service-rig.js";

const code = (c: string, reason?: string) => (e: unknown): boolean => (e as { code?: unknown }).code === c && (reason === undefined || (e as { details?: { reason?: unknown } }).details?.reason === reason);
const REQ = { workspaceId: "ws1", cols: 80, rows: 24 };
type Rig = ReturnType<typeof serviceRig>;
const setP = (r: Rig, patch: Partial<Project>): void => void r.projects.set("p1", { ...(r.projects.get("p1") as Project), ...patch });
const setW = (r: Rig, patch: Partial<Workspace>): void => void r.workspaces.set("ws1", { ...(r.workspaces.get("ws1") as Workspace), ...patch });

async function dispatched(r: ReturnType<typeof serviceRig>, n = 1): Promise<void> {
  for (let i = 0; i < 1000 && r.port.spawns.length < n; i++) await new Promise((res) => setImmediate(res));
  assert.equal(r.port.spawns.length, n, "the spawn was dispatched");
}

test("a granted open: one spawn of the shell alone, in the locator's path, with the given environment; published open, ticket spent, audited", async () => {
  const r = serviceRig();
  const p = openTerminal(r.deps, REQ, r.context());
  await dispatched(r);
  const s = r.port.spawns[0];
  assert.ok(s !== undefined);
  assert.deepEqual([s.spec.argv, s.spec.cwd, s.spec.env, s.spec.cols, s.spec.rows], [["/bin/zsh"], WT, { PATH: "/usr/bin", SSH_AUTH_SOCK: "/run/agent" }, 80, 24]);
  assert.equal(s.spec.messagesEndpoint, undefined, "no messaging endpoint");
  const h = new FakeHandle();
  s.resolve(h);
  const rec = await p;
  assert.deepEqual([rec.terminalId, rec.state, rec.kind, rec.workspaceId, rec.projectId], [h.terminalId, "open", "plain", "ws1", "p1"]);
  assert.equal(spendTicket(r.tickets[0], { projectId: "p1", workspaceId: "ws1" }, () => 1000, 1000), false, "the ticket was consumed");
  assert.deepEqual(r.audits.map((a) => [a.action, a.payload]), [["terminal.open", { terminalId: h.terminalId, workspaceId: "ws1", projectId: "p1" }]]);
});

test("an unknown, foreign, not-READY or removed workspace is not_found before anything", async () => {
  for (const [label, change] of [
    ["unknown", (r: ReturnType<typeof serviceRig>) => void r.workspaces.delete("ws1")],
    ["not READY", (r: ReturnType<typeof serviceRig>) => void r.workspaces.set("ws1", { ...r.workspaces.get("ws1"), state: "CREATING" } as Workspace)],
    ["removed", (r: ReturnType<typeof serviceRig>) => void r.workspaces.set("ws1", { ...r.workspaces.get("ws1"), state: "REMOVED" } as Workspace)],
    ["no path", (r: ReturnType<typeof serviceRig>) => void r.workspaces.set("ws1", { ...r.workspaces.get("ws1"), worktreePath: null } as Workspace)],
    ["an unknown project", (r: ReturnType<typeof serviceRig>) => void r.projects.delete("p1")],
  ] as const) {
    const r = serviceRig();
    change(r);
    await assert.rejects(openTerminal(r.deps, REQ, r.context()), code("E_NOT_FOUND"), label);
    assert.equal(r.port.spawns.length, 0, label);
  }
});

test("the locator refusing (a linked, replaced or foreign directory, a replaced root), first or after the gate, refuses before the spawn", async () => {
  for (const n of [1, 2]) {
    const r = serviceRig();
    r.hooks.locateFails = (k) => k === n;
    await assert.rejects(openTerminal(r.deps, REQ, r.context()), code("E_NOT_FOUND"), `locate ${n}`);
    assert.equal(r.port.spawns.length, 0);
  }
  const r = serviceRig();
  r.hooks.belongs = false; // a worktree of another repository
  await assert.rejects(openTerminal(r.deps, REQ, r.context()), code("E_NOT_FOUND"));
  assert.equal(r.port.spawns.length, 0);
});

test("an untrusted project is refused by the gate, and nothing is spawned", async () => {
  const r = serviceRig();
  setP(r, { trusted: false });
  await assert.rejects(openTerminal(r.deps, REQ, r.context()), code("E_POLICY_DENIED"));
  assert.equal(r.port.spawns.length, 0);
});

test("each change landing inside the gate's await is refused by the final admission, with no spawn and no slot", async () => {
  const cases: Array<[string, (r: ReturnType<typeof serviceRig>) => void]> = [
    ["untrust", (r) => setP(r, { trusted: false })],
    ["a new binding", (r) => setP(r, { gitDirId: "9:9" })],
    ["a new common directory alone (review S4)", (r) => setP(r, { commonDir: "/elsewhere/.git" })],
    ["a moved project", (r) => setP(r, { path: "/other" })],
    ["a window revoke", (r) => r.trust.set({ windowId: "w1" }, false)],
    ["a workspace revoke", (r) => r.trust.set({ windowId: "w9", workspaceId: "ws1" }, false)],
    ["a project revoke", (r) => r.trust.set({ windowId: "w9", workspaceId: "p1" }, false)],
    ["the workspace leaving READY", (r) => setW(r, { state: "FINALISED" })],
    ["the workspace locked", (r) => setW(r, { lockState: "locked", lockedAt: "t2" })],
    ["the lock state alone", (r) => setW(r, { lockState: "locked" })],
    ["the lock identity alone (re-taken)", (r) => setW(r, { lockedAt: "t3" })],
  ];
  for (const [label, change] of cases) {
    const r = serviceRig();
    r.hooks.inGate = () => change(r);
    await assert.rejects(openTerminal(r.deps, REQ, r.context()), (e: unknown) => (e as { code?: unknown }).code !== undefined, label);
    assert.equal(r.port.spawns.length, 0, `${label}: no spawn`);
    assert.equal(r.registry.reserve("ws1", "p1") !== undefined, true, `${label}: no slot held`);
  }
});

test("a path changed after the last locate (inside the binding check) is refused by the final admission", async () => {
  const r = serviceRig();
  r.hooks.inBelongs = () => setW(r, { worktreePath: "/root/worktrees/other" });
  await assert.rejects(openTerminal(r.deps, REQ, r.context()), code("E_NOT_FOUND"));
  assert.equal(r.port.spawns.length, 0);
});

test("a cancellation inside the gate refuses before any spawn", async () => {
  const r = serviceRig();
  r.hooks.inGate = () => r.ctl.abort();
  await assert.rejects(openTerminal(r.deps, REQ, r.context()));
  assert.equal(r.port.spawns.length, 0);
});

test("a cancellation after the gate (inside the binding check) is refused by the final admission, before any spawn", async () => {
  const r = serviceRig();
  r.hooks.inBelongs = () => r.ctl.abort();
  await assert.rejects(openTerminal(r.deps, REQ, r.context()), code("E_CANCELLED"));
  assert.equal(r.port.spawns.length, 0);
});

test("no shell, or a workspace that needs attention, refuses before the gate", async () => {
  const r = serviceRig({ shell: async () => undefined });
  await assert.rejects(openTerminal(r.deps, REQ, r.context()), code("E_UNAVAILABLE", "shell_unavailable"));
  const a = serviceRig({ needsAttention: () => true });
  await assert.rejects(openTerminal(a.deps, REQ, a.context()), code("E_UNAVAILABLE", "needs_attention"));
  assert.equal(r.tickets.length + a.tickets.length, 0);
});

test("a cancellation while the spawn is pending: cancelled, and the handle that comes later is revoked, killed, never published", async () => {
  const r = serviceRig();
  const p = openTerminal(r.deps, REQ, r.context());
  await dispatched(r);
  r.ctl.abort();
  await assert.rejects(p, code("E_CANCELLED"));
  const h = new FakeHandle();
  h.survives = true;
  r.port.spawns[0]?.resolve(h);
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(r.port.revokes, [h.terminalId]);
  assert.deepEqual(h.kills, ["SIGKILL"]);
  assert.deepEqual(r.registry.list(), []);
});

test("a project untrust while the spawn is pending: the late handle is never published", async () => {
  const r = serviceRig();
  const p = openTerminal(r.deps, REQ, r.context());
  await dispatched(r);
  r.registry.projectRevoked("p1");
  const h = new FakeHandle();
  r.port.spawns[0]?.resolve(h);
  await assert.rejects(p, code("E_UNAVAILABLE", "spawn_failed"));
  assert.deepEqual(h.kills, ["SIGKILL"]);
  assert.deepEqual(r.registry.list(), []);
});

test("a spawn that timed out keeps its slot; its late group is tracked until gone", async () => {
  const r = serviceRig({ registry: undefined as never });
  const { TerminalRegistry } = await import("../../src/terminals/registry.js");
  const registry = new TerminalRegistry({ port: r.port, maxPerWorkspace: 1 });
  const deps = { ...r.deps, registry };
  const p = openTerminal(deps, REQ, r.context());
  await dispatched(r);
  const s = r.port.spawns[0];
  s?.reject(spawnError("timeout", false));
  await assert.rejects(p, code("E_UNAVAILABLE", "spawn_failed"));
  r.tick(1);
  await assert.rejects(openTerminal(deps, REQ, r.context()), code("E_CONFLICT", "too_many_terminals"), "still charged");
  const h = new FakeHandle();
  h.survives = true;
  s?.onLate({ kind: "spawned", handle: h });
  await assert.rejects(openTerminal(deps, REQ, r.context()), code("E_CONFLICT", "too_many_terminals"), "the late group keeps it");
  h.alive = false;
  const again = openTerminal(deps, REQ, r.context());
  await dispatched(r, 2);
  r.port.spawns[1]?.resolve(new FakeHandle());
  assert.equal((await again).state, "open");
});

test("with 8 open in the workspace a ninth is too_many_terminals, without a spawn", async () => {
  const r = serviceRig();
  for (let i = 0; i < 8; i++) {
    const p = openTerminal(r.deps, REQ, r.context());
    await dispatched(r, i + 1);
    r.port.spawns[i]?.resolve(new FakeHandle());
    await p;
  }
  await assert.rejects(openTerminal(r.deps, REQ, r.context()), code("E_CONFLICT", "too_many_terminals"));
  assert.equal(r.port.spawns.length, 8);
});

test("review S2: a cancellation in the same tick as the spawn's answer ends the published terminal (closing, revoked, killed) and audits it", async () => {
  const r = serviceRig();
  const p = openTerminal(r.deps, REQ, r.context());
  await dispatched(r);
  const h = new FakeHandle();
  r.port.spawns[0]?.resolve(h);
  r.ctl.abort(); // before the race settles: the record may already be published
  await assert.rejects(p, code("E_CANCELLED"));
  assert.equal(r.registry.attachable(h.terminalId), undefined, "never attachable");
  assert.notEqual(r.registry.get(h.terminalId)?.state, "open");
  assert.deepEqual(h.kills, ["SIGKILL"]);
  assert.deepEqual(r.port.revokes, [h.terminalId]);
  assert.deepEqual(r.audits.map((a) => [a.action, a.outcome]), [["terminal.open", "success"], ["terminal.close", "success"]], "the shell that existed is audited opened, then closed");
});
