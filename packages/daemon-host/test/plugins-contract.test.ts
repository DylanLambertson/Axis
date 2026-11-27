// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-K2 slice K2-g1: axis.plugins/1 (list, revoke, disable) through the real daemon pipeline, policy, gate and journal. A decrease
// ends that plugin's open challenges in that project at once, and nothing else.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { MessagePort } from "node:worker_threads";
import { test, type TestContext } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { Daemon, MemoryIdempotencyStore, memoryPair, protocolRegistry, requestDigest, type HandlerContext, type Identity, type IdentityVerifier, type PolicyInput } from "@axis/daemon";
import { Journal, PLUGIN_PERMISSIONS } from "@axis/journal";
import { PLUGIN_PERMISSION_NAMES, type Challenge } from "@axis/protocol";
import { createApprovals, createApprovalsHandlers, InMemoryTrustRegistry, RULES, RuleTablePolicy, type NativeControl } from "../src/index.js";
import { pluginRunStartChallenges } from "../src/gate/plugin-run-start.js";
import { createPluginsHandlers, registerPluginsHandlers } from "../src/handlers/plugins.js";
import { PLUGIN_DENY_CONTRACTS, pluginCoverageProblems } from "../src/policy/plugin-rules.js";
import { ProjectMutex } from "../src/worktrees/project-mutex.js";
import { Client } from "./approvals-rig.js";
import { fakeClock } from "./helpers.js";

const SHA = "b".repeat(40);

const verifier: IdentityVerifier = {
  verify(att) {
    if (typeof att !== "string") return undefined;
    const [actor, conn, windowId, host, project] = att.split("#");
    if (actor?.startsWith("plugin:") === true) {
      return { connectionId: (conn as string).padEnd(22, "_"), windowId: windowId as string, actorId: actor, actor: actor as Identity["actor"], workspaceId: project as string, trusted: false, clientKind: "plugin", hostWindowId: host as string };
    }
    return { connectionId: (conn as string).padEnd(22, "_"), windowId: windowId as string, actorId: "user-id", actor: "user", trusted: true, clientKind: windowId === "web" ? "web" : "desktop" };
  },
};

async function setup(t: TestContext, over: { endPlugin?: (pluginId: string, projectId: string) => number } = {}) {
  const clock = fakeClock();
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db);
  const journal = Journal.open(db, { audit });
  for (const [id, name] of [["p1", "One"], ["p2", "Two"]] as const) journal.registerProject({ id, path: `/repo/${id}`, displayName: name, trusted: false, actor: "user" });
  const ws = (projectId: string) => {
    const w = journal.createWorkspace({ projectId, branch: `feature-${projectId}`, baseRef: "main", baseSha: SHA, createdBy: "user" }).value;
    journal.transitionWorkspace(w.id, "READY");
    return w.id;
  };
  const wsOf = { p1: ws("p1"), p2: ws("p2") };
  for (const [plugin, project] of [["acme.board", "p1"], ["other.tool", "p1"], ["acme.board", "p2"]] as const) {
    journal.plugins.add(plugin, project);
    journal.plugins.setEnabled(plugin, project, true);
    journal.plugins.grant(plugin, project, "runs.start");
    journal.plugins.grant(plugin, project, "pages.read");
  }
  const control: NativeControl = { nativeConfirm: () => new Promise(() => undefined) };
  const approvals = createApprovals({ audit: { append() {} }, control, clock, plugins: pluginRunStartChallenges(journal, journal.pluginIssues, () => clock.now()) });
  const daemon = new Daemon({ identity: verifier, audit: { append() {} }, registry: protocolRegistry, idempotency: new MemoryIdempotencyStore(), policy: new RuleTablePolicy(new InMemoryTrustRegistry(), RULES, journal.plugins), approvals: approvals.gate });
  daemon.register("axis.approvals", 1, createApprovalsHandlers({ approvals: approvals.port }));
  registerPluginsHandlers({ register: (c, v, h) => daemon.register(c, v, h) }, { journal, mutex: new ProjectMutex(), endPlugin: over.endPlugin ?? ((p, j) => approvals.endPlugin(p, j)) });
  const ports: MessagePort[] = [];
  const connect = async (att: string): Promise<Client> => {
    const { client, server } = memoryPair();
    ports.push(client);
    const c = new Client(client);
    daemon.accept(server, att);
    await c.hello();
    return c;
  };
  t.after(() => {
    approvals.dispose();
    daemon.stop();
    for (const p of ports) p.close();
    db.close();
  });
  // A plugin's open run-start challenge, issued through the real gate (as the pipeline would for its axis.runs/1.start).
  const pluginChallenge = async (pluginId: string, projectId: "p1" | "p2", host = "w1"): Promise<Challenge> => {
    const identity = verifier.verify(`plugin:${pluginId}#P${pluginId.replace(/\./g, "_")}${projectId}#p9#${host}#${projectId}`) as Identity;
    const args = { workspaceId: wsOf[projectId], mode: "edit", prompt: "Summarise", providerId: "mock", modelId: "mock-model" };
    return (await approvals.gate.issue(
      { identity, actor: identity.actor, connectionId: identity.connectionId, requestId: "r", correlationId: "x", contract: "axis.runs", contractVersion: 1, method: "start", tier: 3, args, digest: requestDigest("axis.runs", 1, "start", args), signal: new AbortController().signal } as never,
      { target: `workspace:${wsOf[projectId]}`, contentDigest: "e".repeat(64) },
    )) as Challenge;
  };
  // The user's own tier-3 challenge in the same window.
  const userChallenge = async (): Promise<Challenge> => {
    const identity = verifier.verify("user#Uown#w1") as Identity;
    const args = { id: "x" };
    return (await approvals.gate.issue(
      { identity, actor: "user", connectionId: identity.connectionId, requestId: "r", correlationId: "x", contract: "axis.worktrees", contractVersion: 1, method: "remove", tier: 3, args, digest: requestDigest("axis.worktrees", 1, "remove", args), signal: new AbortController().signal } as never,
      { target: "workspace:x", contentDigest: "e".repeat(64) },
    )) as Challenge;
  };
  const pendingIds = (windowId = "w1"): string[] => approvals.port.pending(windowId).map((c) => c.challengeId).sort();
  return { journal, audit, approvals, connect, pluginChallenge, userChallenge, pendingIds };
}
const gen = (s: Awaited<ReturnType<typeof setup>>, plugin: string, project: string): number | undefined => s.journal.plugins.state(plugin, project)?.generation;

test("the protocol's permission set is the journal's closed set, in the same order", () => {
  assert.deepEqual([...PLUGIN_PERMISSION_NAMES], [...PLUGIN_PERMISSIONS]);
});

test("policy: the user's desktop connection may call list (0), revoke (2) and disable (2); a web client, a plugin and a worker may not", async (t) => {
  const s = await setup(t);
  const policy = new RuleTablePolicy(new InMemoryTrustRegistry(), RULES, s.journal.plugins);
  const ask = (identity: Identity, method: string, tier: number): PolicyInput => ({ identity, contract: "axis.plugins", version: 1, method, sideEffect: method === "list" ? "read" : "write", tier });
  const desktop = verifier.verify("user#Uone#w1") as Identity;
  for (const [m, tier] of [["list", 0], ["revoke", 2], ["disable", 2]] as const) {
    const d = policy.evaluate(ask(desktop, m, tier));
    assert.equal(d.effect, "allow", m);
    assert.equal(RULES[`axis.plugins/1.${m}`]?.tier, tier, `${m} row tier`);
    assert.equal(policy.evaluate(ask(verifier.verify("user#Uweb#web") as Identity, m, tier)).effect, "deny", `${m} web`);
    assert.equal(policy.evaluate(ask(verifier.verify("plugin:acme.board#Pacme#p1#w1#p1") as Identity, m, tier)).effect, "deny", `${m} plugin`);
    assert.equal(policy.evaluate(ask({ ...desktop, actor: "agent:composer.r1", actorId: "agent:composer.r1" } as Identity, m, tier)).effect, "deny", `${m} worker`);
  }
  assert.ok(PLUGIN_DENY_CONTRACTS.includes("axis.plugins/"));
  assert.ok(pluginCoverageProblems(RULES, { "runs.start": ["axis.plugins/1.revoke"] }).length > 0, "a plugin set naming the contract fails the coverage check");
});

test("list: every plugin of the project with its switch, generation and sorted permissions; another project's are not shown", async (t) => {
  const s = await setup(t);
  s.journal.plugins.add("solo.two", "p2"); // in p2 only: never listed for p1
  const user = await s.connect("user#Uone#w1");
  const res = await user.call("axis.plugins", "list", { projectId: "p1" });
  assert.deepEqual(res.result, { plugins: [
    { pluginId: "acme.board", enabled: true, generation: 1, permissions: ["pages.read", "runs.start"] },
    { pluginId: "other.tool", enabled: true, generation: 1, permissions: ["pages.read", "runs.start"] },
  ] });
  assert.equal((await user.call("axis.plugins", "list", { projectId: "nope" })).error?.code, "E_NOT_FOUND");
});

test("revoke: one permission goes, the generation grows by one, and that plugin's open challenges in that project end at once", async (t) => {
  const s = await setup(t);
  const target = await s.pluginChallenge("acme.board", "p1");
  const otherPlugin = await s.pluginChallenge("other.tool", "p1");
  const mine = await s.userChallenge();
  // One plugin holds one open challenge across projects (OI-2), so the project filter is checked by ending p2's: p1's stays.
  assert.equal(s.approvals.endPlugin("acme.board", "p2"), 0);
  assert.deepEqual(s.pendingIds(), [target.challengeId, otherPlugin.challengeId, mine.challengeId].sort());
  assert.deepEqual(s.pendingIds(), [target.challengeId, otherPlugin.challengeId, mine.challengeId].sort());
  const user = await s.connect("user#Uone#w1");
  const res = await user.call("axis.plugins", "revoke", { projectId: "p1", pluginId: "acme.board", permission: "runs.start" }, randomUUID());
  assert.deepEqual(res.result, { plugin: { pluginId: "acme.board", enabled: true, generation: 2, permissions: ["pages.read"] } });
  assert.deepEqual(s.pendingIds(), [otherPlugin.challengeId, mine.challengeId].sort(), "only that plugin's challenge in that project ended");
  assert.equal(gen(s, "other.tool", "p1"), 1);
  assert.equal(gen(s, "acme.board", "p2"), 1);
});

test("revoke of a permission not granted, or of an unknown plugin, changes nothing", async (t) => {
  const s = await setup(t);
  const target = await s.pluginChallenge("acme.board", "p1");
  const user = await s.connect("user#Uone#w1");
  const notGranted = await user.call("axis.plugins", "revoke", { projectId: "p1", pluginId: "acme.board", permission: "files.read" }, randomUUID());
  assert.equal(notGranted.error?.code, "E_NOT_FOUND");
  assert.equal(notGranted.error?.details?.["reason"], "not_granted");
  assert.equal((await user.call("axis.plugins", "revoke", { projectId: "p1", pluginId: "nobody.here", permission: "runs.start" }, randomUUID())).error?.code, "E_NOT_FOUND");
  assert.equal((await user.call("axis.plugins", "disable", { projectId: "p1", pluginId: "nobody.here" }, randomUUID())).error?.code, "E_NOT_FOUND");
  assert.equal((await user.call("axis.plugins", "disable", { projectId: "p2", pluginId: "other.tool" }, randomUUID())).error?.code, "E_NOT_FOUND", "a plugin of another project");
  assert.equal(gen(s, "acme.board", "p1"), 1);
  assert.deepEqual(s.pendingIds(), [target.challengeId], "nothing was ended");
});

test("disable: the switch goes off, the grants stay, the generation grows by one, the challenges end; a second disable changes nothing", async (t) => {
  const s = await setup(t);
  await s.pluginChallenge("acme.board", "p1");
  const user = await s.connect("user#Uone#w1");
  const first = await user.call("axis.plugins", "disable", { projectId: "p1", pluginId: "acme.board" }, randomUUID());
  assert.deepEqual(first.result, { plugin: { pluginId: "acme.board", enabled: false, generation: 2, permissions: ["pages.read", "runs.start"] } });
  assert.deepEqual(s.pendingIds(), []);
  const again = await user.call("axis.plugins", "disable", { projectId: "p1", pluginId: "acme.board" }, randomUUID());
  assert.deepEqual(again.result, { plugin: { pluginId: "acme.board", enabled: false, generation: 2, permissions: ["pages.read", "runs.start"] } }, "a no-op disable leaves the generation unchanged");
});

test("an approval already given cannot be spent after a revoke", async (t) => {
  const s = await setup(t);
  const c = await s.pluginChallenge("acme.board", "p1");
  assert.equal(s.approvals.port.resolve({ actor: "user", windowId: "w1" }, { challengeId: c.challengeId, decision: "approve", digest: c.digest }).state, "approved");
  const user = await s.connect("user#Uone#w1");
  await user.call("axis.plugins", "revoke", { projectId: "p1", pluginId: "acme.board", permission: "runs.start" }, randomUUID());
  const identity = verifier.verify("plugin:acme.board#Pacme_boardp1#p9#w1#p1") as Identity;
  const args = { workspaceId: "x" };
  await assert.rejects(Promise.resolve(s.approvals.gate.execute({ identity, actor: identity.actor, connectionId: identity.connectionId, contract: "axis.runs", contractVersion: 1, method: "start", tier: 3, args, digest: requestDigest("axis.runs", 1, "start", args), signal: new AbortController().signal } as never, { challengeId: c.challengeId }, { target: "x", contentDigest: "e".repeat(64) }, () => Promise.reject(new Error("must not run")))));
});

test("the handlers refuse every caller but the user's desktop connection, before reading anything", async (t) => {
  const s = await setup(t);
  let reads = 0;
  const journal = { getProject: (id: string) => (reads++, s.journal.getProject(id)), plugins: s.journal.plugins };
  const h = createPluginsHandlers({ journal, mutex: new ProjectMutex(), endPlugin: () => 0 });
  const ctx = (identity: Identity): HandlerContext => ({ identity, requestId: "r", correlationId: "x", signal: new AbortController().signal }) as unknown as HandlerContext;
  for (const att of ["user#Uweb#web", "plugin:acme.board#Pacme#p1#w1#p1"]) {
    for (const [m, payload] of [["list", { projectId: "p1" }], ["revoke", { projectId: "p1", pluginId: "acme.board", permission: "runs.start" }], ["disable", { projectId: "p1", pluginId: "acme.board" }]] as const) {
      await assert.rejects(Promise.resolve(h[m](ctx(verifier.verify(att) as Identity), payload as never)), (e: unknown) => (e as { code?: string }).code === "E_NOT_FOUND", `${att} ${m}`);
    }
  }
  const worker = { ...(verifier.verify("user#Uone#w1") as Identity), actor: "agent:composer.r1" } as Identity;
  await assert.rejects(Promise.resolve(h.disable(ctx(worker), { projectId: "p1", pluginId: "acme.board" } as never)));
  assert.equal(reads, 0);
  assert.equal(gen(s, "acme.board", "p1"), 1);
});

test("a failing endPlugin never undoes the decrease", async (t) => {
  const s = await setup(t, { endPlugin: () => { throw new Error("boom"); } });
  const user = await s.connect("user#Uone#w1");
  const res = await user.call("axis.plugins", "revoke", { projectId: "p1", pluginId: "acme.board", permission: "runs.start" }, randomUUID());
  assert.equal(res.ok, true);
  assert.deepEqual(s.journal.plugins.state("acme.board", "p1")?.permissions, ["pages.read"]);
});

test("every decrease is audited as the user's, with ids and the permission only", async (t) => {
  const s = await setup(t);
  const user = await s.connect("user#Uone#w1");
  await user.call("axis.plugins", "revoke", { projectId: "p1", pluginId: "acme.board", permission: "runs.start" }, randomUUID());
  await user.call("axis.plugins", "disable", { projectId: "p1", pluginId: "other.tool" }, randomUUID());
  const rows = s.audit.list().filter((e) => e.action === "journal.plugin.record").slice(-2);
  assert.deepEqual(rows.map((e) => [e.actor, e.payload]), [
    ["user", { field: "revoked", pluginId: "acme.board", projectId: "p1", permission: "runs.start" }],
    ["user", { field: "disabled", pluginId: "other.tool", projectId: "p1" }],
  ]);
});
