// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-K1c (ADR 0008 decision 4): the project trust gate for a plugin view, and the forced scope of a plugin call.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AxisError } from "@axis/audit";
import { forcedScope } from "../src/gate/plugin-scope.js";
import { createProjectTrustGate } from "../src/gate/project-trust-gate.js";
import { consumeTicket, trustCallOf, type ProjectTrustGateDeps, type TrustCall } from "../src/gate/project-trust.js";
import { attestedPlugin, attestedWindow } from "../testing/attested.js";

const untrusted = (e: unknown) => e instanceof AxisError && e.code === "E_POLICY_DENIED" && e.detail["reason"] === "untrusted";
const signal = new AbortController().signal;
const PLUGIN = { windowId: "p7", clientKind: "plugin", hostWindowId: "w3", workspaceId: "p" } as const;
const plugin = () => trustCallOf(attestedPlugin());

function rig(revoked: readonly string[] = [], projects: Record<string, string> = { ws: "p", "ws-q": "q" }) {
  const calls: string[] = [];
  const row = (id: string) => ({ id, path: `/r-${id}`, trusted: true, commonDir: `/r-${id}/.git`, gitDirId: "1:2" });
  const deps: ProjectTrustGateDeps = {
    journal: {
      getProject: (id: string) => (calls.push(`T1:${id}`), id === "p" || id === "q" ? (row(id) as never) : undefined),
      getWorkspace: (id: string) => (projects[id] === undefined ? undefined : ({ id, projectId: projects[id], worktreePath: "/wt" } as never)),
      setProjectTrust: () => undefined as never,
    },
    binding: async (path) => (calls.push("T2"), { ok: true, binding: { path, commonDir: `${path}/.git`, gitDirId: "1:2" } }),
    trustCheck: async (r) => void calls.push(`T3:${r.windowId}`),
    registry: { isRevoked: (s) => (calls.push(`T4:${s.windowId}`), revoked.includes(s.windowId)) },
    now: () => 1_000,
    fs: {
      lstat: (async () => ({ isFile: () => true, size: 40 })) as never,
      readFile: (async (p: string) => (String(p).endsWith(".git") ? "gitdir: /r-p/.git/worktrees/w\n" : "/r-p/.git\n")) as never,
      realpath: (async (p: string) => String(p)) as never,
    },
  };
  return { gate: createProjectTrustGate(deps), calls };
}

test("a plugin view is asked for by its host window at T3, and both windows are checked at T4", async () => {
  const r = rig();
  const t = await r.gate.admit({ projectId: "p", caller: plugin(), workspaceId: "ws", signal });
  assert.deepEqual(r.calls, ["T1:p", "T2", "T3:w3", "T1:p", "T4:p7", "T4:w3"]);
  consumeTicket(t, { projectId: "p", workspaceId: "ws" }, () => 1_000);
  assert.throws(() => consumeTicket(t, { projectId: "p", workspaceId: "ws" }, () => 1_000), untrusted, "single use");
});

test("a revoke on the host window, or on the view's own window, refuses the plugin", async () => {
  for (const w of ["w3", "p7"]) await assert.rejects(rig([w]).gate.admit({ projectId: "p", caller: plugin(), signal }), untrusted, w);
});

test("a plugin is pinned to its project: another project, or another project's workspace, is refused before any step", async () => {
  const other = rig();
  await assert.rejects(other.gate.admit({ projectId: "q", caller: plugin(), signal }), untrusted);
  assert.deepEqual(other.calls, [], "refused before T1");
  await assert.rejects(rig().gate.admit({ projectId: "p", caller: plugin(), workspaceId: "ws-q", signal }), untrusted, "a workspace of another project");
  await assert.rejects(rig().gate.admit({ projectId: "q", caller: plugin(), workspaceId: "ws-q", signal }), untrusted, "even naming that project");
});

test("a plugin identity missing its host window or project is refused (it cannot be attested; a literal is refused anyway)", async () => {
  for (const bad of [{ ...PLUGIN, hostWindowId: undefined }, { ...PLUGIN, workspaceId: undefined }, { ...PLUGIN, hostWindowId: "" }]) {
    const r = rig();
    await assert.rejects(r.gate.admit({ projectId: "p", caller: trustCallOf(bad as never), signal }), untrusted);
    assert.deepEqual(r.calls, []);
  }
});

test("only trustCallOf makes a call: a hand-built object, a copy or a desktop window id smuggled in is refused before any step", async () => {
  const r = rig();
  const real = trustCallOf(attestedWindow("w1"));
  for (const fake of [{ windowId: "w1" }, { ...real }, Object.freeze({ windowId: "w3" }), null, undefined]) {
    await assert.rejects(r.gate.admit({ projectId: "p", caller: fake as unknown as TrustCall, signal }), untrusted);
  }
  assert.deepEqual(r.calls, []);
  assert.equal(Object.isFrozen(real), true);
  await r.gate.admit({ projectId: "p", caller: real, signal });
});

test("only the attested identity object makes a call the gate accepts: a literal, a spread, a structured clone or a JSON copy is refused", async () => {
  const real = attestedPlugin();
  const r = rig();
  for (const made of [{ ...PLUGIN }, { ...real }, structuredClone(real), JSON.parse(JSON.stringify(real)), Object.create(real), { windowId: "w1", clientKind: "desktop" }]) {
    await assert.rejects(r.gate.admit({ projectId: "p", caller: trustCallOf(made), signal }), untrusted);
  }
  assert.deepEqual(r.calls, [], "refused before any step");
  await r.gate.admit({ projectId: "p", caller: trustCallOf(real), signal });
  assert.equal(Object.isFrozen(real), true, "the attested identity cannot be edited in place");
});

test("however the gate is reached (an alias, a bracket, a destructured or a bound admit), a made-up caller is refused at run time", async () => {
  const r = rig();
  const forged = trustCallOf({ windowId: "w1", clientKind: "desktop" });
  const handBuilt = { windowId: "w1" } as unknown as TrustCall;
  const alias = r.gate.admit;
  const { admit } = r.gate;
  const bound = r.gate.admit.bind(r.gate);
  const spellings: Array<(call: TrustCall) => Promise<unknown>> = [
    (caller) => alias.call(r.gate, { projectId: "p", caller, signal }),
    (caller) => r.gate["admit"]({ projectId: "p", caller, signal }),
    (caller) => admit.call(r.gate, { projectId: "p", caller, signal }),
    (caller) => bound({ projectId: "p", caller, signal }),
  ];
  for (const go of spellings) for (const caller of [forged, handBuilt]) await assert.rejects(go(caller), untrusted);
  assert.deepEqual(r.calls, []);
});

test("a desktop window's call is unchanged: T3 and T4 see its own window only", async () => {
  const r = rig();
  await r.gate.admit({ projectId: "p", caller: trustCallOf(attestedWindow("w1", { workspaceId: "anything" })), signal });
  assert.deepEqual(r.calls, ["T1:p", "T2", "T3:w1", "T1:p", "T4:w1"]);
});

test("every gated call in the host's source is built by trustCallOf (or passes the attested one through); none names a window", () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".ts")) files.push(p);
    }
  };
  walk(src);
  let sites = 0;
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/\.admit\(/g)) {
      sites += 1;
      const rest = text.slice((m.index ?? 0) + m[0].length);
      const body = rest.slice(0, rest.indexOf("signal"));
      assert.match(body, /caller: (trustCallOf\(|ctx\.caller\.trust as TrustCall)/, f);
      assert.doesNotMatch(body, /windowId/, f);
    }
  }
  assert.ok(sites >= 6, `found ${sites} gated call sites`);
});

test("forcedScope: a plugin gets its own project; another project or workspace is refused without echoing the id", () => {
  const owner = (ws: string) => ({ ws: "p", "ws-q": "q" })[ws];
  assert.deepEqual(forcedScope(PLUGIN, {}, owner), { ok: true, projectId: "p" });
  assert.deepEqual(forcedScope(PLUGIN, { projectId: "p" }, owner), { ok: true, projectId: "p" });
  assert.deepEqual(forcedScope(PLUGIN, { workspaceId: "ws" }, owner), { ok: true, projectId: "p", workspaceId: "ws" });
  for (const asked of [{ projectId: "secret-other" }, { workspaceId: "ws-q" }, { workspaceId: "nope" }, { projectId: "p", workspaceId: "ws-q" }]) {
    const r = forcedScope(PLUGIN, asked, owner);
    assert.deepEqual(r, { ok: false, reason: "out_of_scope" });
    assert.ok(!JSON.stringify(r).includes("secret-other") && !JSON.stringify(r).includes("ws-q"));
  }
  assert.deepEqual(forcedScope({ ...PLUGIN, workspaceId: undefined } as never, {}, owner), { ok: false, reason: "out_of_scope" });
  assert.deepEqual(forcedScope(PLUGIN, { workspaceId: "ws" }, () => { throw new Error("x"); }), { ok: false, reason: "out_of_scope" });
  assert.deepEqual(forcedScope({ clientKind: "desktop" }, { projectId: "q", workspaceId: "ws-q" }, owner), { ok: true, projectId: "q", workspaceId: "ws-q" }, "not a plugin");
});
