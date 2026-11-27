// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-K1e-b: a plugin's axis.runs/1.start through the real pipeline: the policy (grant, tier 3), the content hook (scope, the grant
// generation in the digest), the gate (host window, binding, bounds) and the handler (scope and grant again, the mutex, the trust
// gate through the host window, the initiator from the attested identity). The composer service is a recording fake; K1e-a tests
// the real one.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { MessagePort } from "node:worker_threads";
import { test, type TestContext } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { Daemon, MemoryIdempotencyStore, memoryPair, protocolRegistry, type HandlerContext, type Identity, type IdentityVerifier } from "@axis/daemon";
import { Journal } from "@axis/journal";
import type { ComposerRun } from "@axis/protocol";
import { createApprovals, createApprovalsHandlers, InMemoryTrustRegistry, RULES, RuleTablePolicy, type NativeControl } from "../src/index.js";
import { composerFailure } from "../src/composer/errors.js";
import { isTrustCall } from "../src/gate/project-trust.js";
import { pluginRunStartChallenges } from "../src/gate/plugin-run-start.js";
import { createComposerRunsHandlers, registerComposerRunsHandlers } from "../src/handlers/composer-runs.js";
import type { ComposerStartInput } from "../src/ports/composer.js";
import { ProjectMutex } from "../src/worktrees/project-mutex.js";
import { Client } from "./approvals-rig.js";
import { fakeClock } from "./helpers.js";

type Row = Record<string, unknown>;
const SHA = "b".repeat(40);
const PLUGIN_ATT = "plugin:acme.board#Pacme#p7#w1#p1";

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

async function setup(t: TestContext, over: { admit?: () => Promise<void>; onAudit?: (e: Row) => void } = {}) {
  const clock = fakeClock();
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  for (const [id, name] of [["p1", "One"], ["p2", "Two"]] as const) journal.registerProject({ id, path: `/repo/${id}`, displayName: name, trusted: false, actor: "user" });
  const ws = (projectId: string) => {
    const w = journal.createWorkspace({ projectId, branch: `feature-${projectId}`, baseRef: "main", baseSha: SHA, createdBy: "user" }).value;
    journal.transitionWorkspace(w.id, "READY");
    return w.id;
  };
  const ws1 = ws("p1");
  const ws2 = ws("p2");
  const ws1b = ws("p1");
  journal.plugins.add("acme.board", "p1");
  journal.plugins.setEnabled("acme.board", "p1", true);
  journal.plugins.grant("acme.board", "p1", "runs.start");
  const control: NativeControl = { nativeConfirm: () => new Promise(() => undefined) };
  const approvals = createApprovals({ audit: { append() {} }, control, clock, plugins: pluginRunStartChallenges(journal, journal.pluginIssues, () => clock.now()) });
  const daemon = new Daemon({ identity: verifier, audit: { append: (e) => over.onAudit?.(e as unknown as Row) }, registry: protocolRegistry, idempotency: new MemoryIdempotencyStore(), policy: new RuleTablePolicy(new InMemoryTrustRegistry(), RULES, journal.plugins), approvals: approvals.gate });
  daemon.register("axis.approvals", 1, createApprovalsHandlers({ approvals: approvals.port }));
  const starts: ComposerStartInput[] = [];
  const admitted: unknown[] = [];
  const run = (input: ComposerStartInput): ComposerRun => ({ runId: randomUUID(), workspaceId: input.workspaceId, mode: input.mode, providerId: input.providerId, modelId: input.modelId, state: "QUEUED", reason: null, createdAt: "2026-11-26T00:00:00.000Z", startedAt: null, endedAt: null, live: true, awaitingApproval: false, usage: null });
  const none = (): never => assert.fail("not used");
  registerComposerRunsHandlers(
    { register: (c, v, h, o) => (o === undefined ? daemon.register(c, v, h) : daemon.register(c, v, h, o)) },
    {
      service: {
        cancel: none, get: none, list: none, events: none,
        start: async (input) => {
          if (input.grantHolds !== undefined && input.grantHolds() !== true) throw composerFailure("E_CONFLICT", "grant_changed");
          starts.push(input);
          return { run: run(input), replayed: false };
        },
      },
      gate: { admit: async (q: { caller: unknown }) => { admitted.push(q.caller); await over.admit?.(); return "ticket"; } } as never,
      journal,
      mutex: new ProjectMutex(),
      pluginStarts: journal,
    },
  );
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
  const body = (workspaceId = ws1, over: Row = {}) => ({ workspaceId, mode: "edit", prompt: "Summarise the open tasks", providerId: "mock", modelId: "mock-model", ...over });
  return { clock, journal, db, approvals, starts, admitted, connect, body, ws1, ws2, ws1b };
}
const reason = (m: { error?: { details?: Record<string, unknown> } }): unknown => m.error?.details?.["reason"];

test("the full flow: the plugin asks, the user approves in the host window, the plugin's retry starts the run as plugin:<id>", async (t) => {
  const s = await setup(t);
  const plugin = await s.connect(PLUGIN_ATT);
  const user = await s.connect("user#Uone#w1");
  const key = randomUUID();
  const asked = await plugin.call("axis.runs", "start", s.body(), key);
  assert.equal(asked.error?.code, "E_APPROVAL_REQUIRED");
  const challengeId = (asked.error?.details?.["challenge"] as Row)["challengeId"] as string;
  assert.deepEqual(Object.keys(asked.error?.details?.["challenge"] as Row), ["challengeId"], "the plugin learns the id only");
  const listed = (await user.call("axis.approvals", "pending", {})).result?.["challenges"] as Row[];
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0]?.["requester"], { kind: "plugin", pluginId: "acme.board" });
  assert.equal(listed[0]?.["tier"], 3);
  const detail = (await user.call("axis.approvals", "detail", { challengeId })).result?.["detail"] as Row;
  assert.deepEqual(detail, { kind: "runs.start", requester: { kind: "plugin", pluginId: "acme.board" }, prompt: "Summarise the open tasks", project: "One", workspace: "feature-p1", mode: "edit", provider: "mock", model: "mock-model" });
  const resolved = await user.call("axis.approvals", "resolve", { challengeId, decision: "approve", digest: listed[0]?.["digest"] });
  assert.equal(resolved.result?.["state"], "approved");
  const done = await plugin.call("axis.runs", "start", s.body(s.ws1, { approval: { challengeId } }), key);
  assert.equal(done.ok, true, JSON.stringify(done.error));
  assert.equal(s.starts.length, 1);
  const input = s.starts[0] as ComposerStartInput;
  assert.deepEqual(input.initiator, { kind: "plugin", pluginId: "acme.board", generation: 1 });
  assert.equal(input.windowId, "w1", "the run's own approvals go to the host window");
  assert.equal(typeof input.grantHolds, "function");
  assert.equal(isTrustCall(s.admitted[0]), true, "the trust gate is asked with the attested call");
  assert.deepEqual({ ...(s.admitted[0] as Row) }, { windowId: "p7", hostWindowId: "w1", pinnedProjectId: "p1" });
});

test("out of scope: a workspace of another project is refused before any challenge, and nothing is counted", async (t) => {
  const s = await setup(t);
  const plugin = await s.connect(PLUGIN_ATT);
  const asked = await plugin.call("axis.runs", "start", s.body(s.ws2), randomUUID());
  assert.equal(asked.error?.code, "E_NOT_FOUND");
  assert.equal(reason(asked), "out_of_scope");
  assert.equal(s.approvals.stats().pending, 0);
  assert.equal(s.journal.pluginIssues.inLastHour("acme.board", "p1", s.clock.now()), 0);
});

test("a disabled, ungranted or unknown plugin is refused by the policy, before any challenge", async (t) => {
  const s = await setup(t);
  s.journal.plugins.setEnabled("acme.board", "p1", false);
  const plugin = await s.connect(PLUGIN_ATT);
  assert.equal((await plugin.call("axis.runs", "start", s.body(), randomUUID())).error?.code, "E_POLICY_DENIED");
  s.journal.plugins.setEnabled("acme.board", "p1", true);
  s.journal.plugins.revoke("acme.board", "p1", "runs.start");
  assert.equal((await plugin.call("axis.runs", "start", s.body(), randomUUID())).error?.code, "E_POLICY_DENIED");
  const stranger = await s.connect("plugin:other.tool#Pother#p8#w1#p1");
  assert.equal((await stranger.call("axis.runs", "start", s.body(), randomUUID())).error?.code, "E_POLICY_DENIED");
  assert.equal(s.approvals.stats().pending, 0);
});

test("a grant change after issue, after the approval and under the mutex each refuses the start with nothing started", async (t) => {
  const bump = (s: Awaited<ReturnType<typeof setup>>) => {
    s.journal.plugins.setEnabled("acme.board", "p1", false);
    s.journal.plugins.setEnabled("acme.board", "p1", true);
  };
  for (const when of ["after issue", "after approval"] as const) {
    const s = await setup(t);
    const plugin = await s.connect(PLUGIN_ATT);
    const user = await s.connect("user#Uone#w1");
    const key = randomUUID();
    const challengeId = ((await plugin.call("axis.runs", "start", s.body(), key)).error?.details?.["challenge"] as Row)["challengeId"] as string;
    const listed = (await user.call("axis.approvals", "pending", {})).result?.["challenges"] as Row[];
    if (when === "after issue") bump(s);
    await user.call("axis.approvals", "resolve", { challengeId, decision: "approve", digest: listed[0]?.["digest"] });
    if (when === "after approval") bump(s);
    const done = await plugin.call("axis.runs", "start", s.body(s.ws1, { approval: { challengeId } }), key);
    assert.notEqual(done.ok, true, when);
    assert.equal(s.starts.length, 0, when);
  }
  // Under the mutex: the grant changes while the trust gate is asked, after the handler's own check.
  let s: Awaited<ReturnType<typeof setup>> | undefined;
  s = await setup(t, { admit: async () => bump(s as Awaited<ReturnType<typeof setup>>) });
  const plugin = await s.connect(PLUGIN_ATT);
  const user = await s.connect("user#Uone#w1");
  const key = randomUUID();
  const challengeId = ((await plugin.call("axis.runs", "start", s.body(), key)).error?.details?.["challenge"] as Row)["challengeId"] as string;
  const listed = (await user.call("axis.approvals", "pending", {})).result?.["challenges"] as Row[];
  await user.call("axis.approvals", "resolve", { challengeId, decision: "approve", digest: listed[0]?.["digest"] });
  const done = await plugin.call("axis.runs", "start", s.body(s.ws1, { approval: { challengeId } }), key);
  assert.equal(done.error?.code, "E_CONFLICT");
  assert.equal(reason(done), "grant_changed");
  assert.equal(s.starts.length, 0);
});

test("the plugin connection closing (its host window closed) withdraws its challenge", async (t) => {
  const s = await setup(t);
  const plugin = await s.connect(PLUGIN_ATT);
  const user = await s.connect("user#Uone#w1");
  await plugin.call("axis.runs", "start", s.body(), randomUUID());
  assert.equal(((await user.call("axis.approvals", "pending", {})).result?.["challenges"] as Row[]).length, 1);
  plugin.port.close();
  await user.until(() => false, 50).catch(() => undefined);
  assert.equal(((await user.call("axis.approvals", "pending", {})).result?.["challenges"] as Row[]).length, 0);
});

test("a seventh start in an hour is refused, across a disable and enable", async (t) => {
  const s = await setup(t);
  const plugin = await s.connect(PLUGIN_ATT);
  const user = await s.connect("user#Uone#w1");
  for (let i = 0; i < 6; i++) {
    const asked = await plugin.call("axis.runs", "start", s.body(), randomUUID());
    assert.equal(asked.error?.code, "E_APPROVAL_REQUIRED", `start ${i}`);
    const listed = (await user.call("axis.approvals", "pending", {})).result?.["challenges"] as Row[];
    await user.call("axis.approvals", "resolve", { challengeId: listed[0]?.["challengeId"], decision: "deny", digest: listed[0]?.["digest"] });
    s.clock.advance(1);
  }
  s.journal.plugins.setEnabled("acme.board", "p1", false);
  s.journal.plugins.setEnabled("acme.board", "p1", true);
  assert.equal((await plugin.call("axis.runs", "start", s.body(), randomUUID())).error?.code, "E_BACKPRESSURE");
});

test("still closed: a spoofed initiator field, every other runs method, CLI and agent starts; a user start is unchanged", async (t) => {
  const s = await setup(t);
  const plugin = await s.connect(PLUGIN_ATT);
  assert.equal((await plugin.call("axis.runs", "start", s.body(s.ws1, { initiator: { kind: "user" } }), randomUUID())).error?.code, "E_INVALID_ARGUMENT");
  const runId = s.ws1; // any well-formed id: the policy refuses before anything is looked up
  for (const [contract, method, payload] of [["axis.runs", "get", { runId }], ["axis.runs", "list", {}], ["axis.runs", "cancel", { runId }], ["axis.runs", "events", { runId }], ["axis.cli-runs", "start", { workspaceId: s.ws1, agentId: "codex" }]] as const) {
    const res = await plugin.call(contract, method, payload, randomUUID());
    assert.equal(res.error?.code, "E_POLICY_DENIED", `${contract}.${method}: ${JSON.stringify(res.error)}`);
  }
  // axis.agents/1.start shares the start path; the policy keeps it closed to plugins (asked directly: this client does not negotiate it).
  const asPlugin = verifier.verify(PLUGIN_ATT) as Identity;
  const policy = new RuleTablePolicy(new InMemoryTrustRegistry(), RULES, s.journal.plugins);
  assert.equal(policy.evaluate({ identity: asPlugin, contract: "axis.agents", version: 1, method: "start", sideEffect: "write", tier: 2 }).effect, "deny");
  assert.notEqual(policy.evaluate({ identity: asPlugin, contract: "axis.runs", version: 1, method: "start", sideEffect: "write", tier: 2 }).effect, "deny", "while runs.start is granted");
  const user = await s.connect("user#Uone#w1");
  const started = await user.call("axis.runs", "start", s.body(), randomUUID());
  assert.equal(started.ok, true, JSON.stringify(started.error));
  const input = s.starts[0] as ComposerStartInput;
  assert.deepEqual(input.initiator, { kind: "user" });
  assert.equal(input.grantHolds, undefined);
  assert.equal(input.windowId, "w1");
  assert.equal(s.approvals.stats().pending, 0, "a user's tier-2 start asks for no approval");
});

test("the content hook binds the grant generation: a disable and enable moves the digest; the gate's binding sees it too", async (t) => {
  const s = await setup(t);
  const { runStartContentHook } = await import("../src/gate/plugin-run-start.js");
  const hook = runStartContentHook(s.journal) as unknown as (c: { identity: Identity }, p: unknown) => { target: string; withLock: (fn: (d: string) => Promise<string>) => Promise<string> };
  const asPlugin = verifier.verify(PLUGIN_ATT) as Identity;
  const lock = hook({ identity: asPlugin }, s.body());
  assert.equal(lock.target, `workspace:${s.ws1}`);
  const before = await lock.withLock(async (d) => d);
  assert.equal(await lock.withLock(async (d) => d), before, "stable while nothing changes");
  const deps = pluginRunStartChallenges(s.journal, s.journal.pluginIssues, () => 1);
  const bound = deps.bind({ identity: asPlugin, actor: asPlugin.actor, contract: "axis.runs", method: "start", args: s.body() } as never, { target: lock.target, contentDigest: before });
  assert.equal(bound?.valid(), true);
  s.journal.plugins.setEnabled("acme.board", "p1", false);
  s.journal.plugins.setEnabled("acme.board", "p1", true);
  assert.notEqual(await lock.withLock(async (d) => d), before, "the generation moved, so the digest did");
  assert.equal(bound?.valid(), false, "the binding no longer holds");
  // Another field of the start moves it too, and a user's call gets the daemon's own default.
  const other = hook({ identity: asPlugin }, s.body(s.ws1, { prompt: "Something else" }));
  assert.notEqual(await other.withLock(async (d) => d), await lock.withLock(async (d) => d));
  const userLock = hook({ identity: verifier.verify("user#Uone#w1") as Identity }, s.body());
  assert.match(userLock.target, /^request:[0-9a-f]{64}$/);
});

test("bind refuses what is not a plugin run start, out of scope or ungranted; an oversize escaped prompt fails the detail's contract", async (t) => {
  const s = await setup(t);
  const asPlugin = verifier.verify(PLUGIN_ATT) as Identity;
  const deps = pluginRunStartChallenges(s.journal, s.journal.pluginIssues, () => 1);
  const call = (over: Row = {}, args: unknown = s.body()) => deps.bind({ identity: asPlugin, actor: asPlugin.actor, contract: "axis.runs", method: "start", args, ...over } as never, { target: "x", contentDigest: "e".repeat(64) });
  assert.notEqual(call(), undefined);
  assert.equal(call({ method: "cancel" }), undefined);
  assert.equal(call({ contract: "axis.cli-runs" }), undefined);
  assert.equal(call({ identity: verifier.verify("user#Uone#w1") }), undefined);
  assert.equal(call({}, s.body(s.ws2)), undefined, "out of scope");
  assert.equal(call({}, { ...s.body(), extra: 1 }), undefined, "not a start request");
  s.journal.plugins.revoke("acme.board", "p1", "runs.start");
  assert.equal(call(), undefined, "ungranted");
  s.journal.plugins.grant("acme.board", "p1", "runs.start");
  const { MAX_DETAIL_PROMPT, MAX_PROMPT_CHARS, challengeDetailSchema } = await import("@axis/protocol");
  // The longest prompt a start allows, every character a control one: escaped (`\u{1}`, five units each) it passes the cap.
  assert.ok(MAX_PROMPT_CHARS * 5 > MAX_DETAIL_PROMPT);
  const big = call({}, s.body(s.ws1, { prompt: "\u0001".repeat(MAX_PROMPT_CHARS) }));
  assert.notEqual(big, undefined);
  assert.equal(challengeDetailSchema.safeParse(big?.detail).success, false, "escaped past the cap: refused at issue, never cut");
});

// ---- each layer on its own: every check holds even when the step before it was missed ----

test("layer: the content hook refuses an out-of-scope or ungranted start itself, before any challenge", async (t) => {
  const s = await setup(t);
  const { runStartContentHook, grantedGeneration } = await import("../src/gate/plugin-run-start.js");
  const hook = runStartContentHook(s.journal) as unknown as (c: { identity: Identity }, p: unknown) => unknown;
  const asPlugin = verifier.verify(PLUGIN_ATT) as Identity;
  const outOfScope = (f: () => unknown, what: string) => assert.throws(f, (e: unknown) => (e as { code?: string; details?: Row }).code === "E_NOT_FOUND" && (e as { details?: Row }).details?.["reason"] === "out_of_scope", what);
  outOfScope(() => hook({ identity: asPlugin }, s.body(s.ws2)), "another project's workspace");
  s.journal.plugins.setEnabled("acme.board", "p1", false);
  outOfScope(() => hook({ identity: asPlugin }, s.body()), "disabled");
  assert.equal(grantedGeneration(s.journal, "acme.board", "p1"), undefined, "a disabled plugin has no granted generation");
  s.journal.plugins.setEnabled("acme.board", "p1", true);
  assert.equal(grantedGeneration(s.journal, "acme.board", "p1"), 2);
  s.journal.plugins.revoke("acme.board", "p1", "runs.start");
  outOfScope(() => hook({ identity: asPlugin }, s.body()), "ungranted");
});

function handlerRig(s: Awaited<ReturnType<typeof setup>>, mutex = new ProjectMutex()) {
  const seen: ComposerStartInput[] = [];
  const handlers = createComposerRunsHandlers({
    // A service that does NOT check `grantHolds`, so only the handler's own checks are under test.
    service: { cancel: () => assert.fail("no"), get: () => assert.fail("no"), list: () => assert.fail("no"), events: () => assert.fail("no"), start: async (input) => (seen.push(input), { run: { runId: randomUUID(), workspaceId: input.workspaceId, mode: input.mode, providerId: input.providerId, modelId: input.modelId, state: "QUEUED", reason: null, createdAt: "2026-11-26T00:00:00.000Z", startedAt: null, endedAt: null, live: true, awaitingApproval: false, usage: null }, replayed: false }) },
    gate: { admit: async () => "ticket" } as never,
    journal: s.journal,
    mutex,
    pluginStarts: s.journal,
  });
  // What the gate hands the handler on a spend: the capability the binding minted at issue (here, for the rig's own workspace).
  const asPlugin = verifier.verify(PLUGIN_ATT) as Identity;
  const mint = () => pluginRunStartChallenges(s.journal, s.journal.pluginIssues, () => 1).bind({ identity: asPlugin, actor: asPlugin.actor, contract: "axis.runs", method: "start", args: s.body() } as never, { target: "x", contentDigest: "e".repeat(64) })?.approved;
  const ctx = (identity: Identity, approved: unknown = mint()): HandlerContext => ({ identity, requestId: "r", correlationId: "x", signal: new AbortController().signal, ...(approved === false ? {} : { approved: { target: "x", capability: approved } }) }) as unknown as HandlerContext;
  return { handlers, seen, ctx, mutex, mint };
}

test("layer: the handler refuses a plugin's out-of-scope start, an unapproved one, every other method, and any other actor", async (t) => {
  const s = await setup(t);
  const h = handlerRig(s);
  const asPlugin = verifier.verify(PLUGIN_ATT) as Identity;
  const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; details?: Row }) => `${e.code}${e.details?.["reason"] === undefined ? "" : `:${String(e.details["reason"])}`}`);
  assert.equal(await code(Promise.resolve(h.handlers.start(h.ctx(asPlugin), s.body(s.ws2) as never))), "E_NOT_FOUND:out_of_scope");
  assert.equal(await code(Promise.resolve(h.handlers.start(h.ctx(asPlugin, false), s.body() as never))), "E_NOT_FOUND", "no spent approval");
  assert.equal(await code(Promise.resolve(h.handlers.start(h.ctx(asPlugin, { pluginId: "acme.board", projectId: "p1", workspaceId: s.ws1, generation: 1 }), s.body() as never))), "E_NOT_FOUND", "a look-alike the gate did not mint");
  for (const m of ["get", "list", "cancel", "events"] as const) assert.equal(await code(Promise.resolve(h.handlers[m](h.ctx(asPlugin), { runId: s.ws1 } as never))), "E_NOT_FOUND", m);
  const worker = { ...asPlugin, actor: "agent:composer.r1", actorId: "agent:composer.r1", clientKind: "desktop", hostWindowId: undefined } as unknown as Identity;
  assert.equal(await code(Promise.resolve(h.handlers.start(h.ctx(worker), s.body() as never))), "E_NOT_FOUND");
  assert.equal(h.seen.length, 0);
  assert.equal(await code(Promise.resolve(h.handlers.start(h.ctx(asPlugin), s.body() as never))), "ok");
});

test("layer: a grant change while the start waits for the project mutex is refused by the handler, even if the service did not check", async (t) => {
  const s = await setup(t);
  const h = handlerRig(s);
  const asPlugin = verifier.verify(PLUGIN_ATT) as Identity;
  let release!: () => void;
  const held = h.mutex.run("p1", () => new Promise<void>((r) => (release = r)), new AbortController().signal);
  const started = Promise.resolve(h.handlers.start(h.ctx(asPlugin), s.body() as never));
  await new Promise((r) => setImmediate(r));
  s.journal.plugins.setEnabled("acme.board", "p1", false);
  s.journal.plugins.setEnabled("acme.board", "p1", true);
  release();
  await held;
  await assert.rejects(started, (e: unknown) => (e as { code?: string; details?: Row }).code === "E_CONFLICT" && (e as { details?: Row }).details?.["reason"] === "grant_changed");
  assert.equal(h.seen.length, 0);
});

test("review K2 S2: a revoke and re-grant after the spend, before the handler, refuses the start (the approved generation is carried)", async (t) => {
  // The daemon awaits its execute audit row after the spend and before the handler: the grant changes exactly there.
  let s: Awaited<ReturnType<typeof setup>> | undefined;
  let bumped = false;
  s = await setup(t, {
    onAudit: (e) => {
      if (bumped || e["actor"] !== "plugin:acme.board" || e["outcome"] !== "success") return;
      bumped = true;
      const j = (s as Awaited<ReturnType<typeof setup>>).journal;
      j.plugins.revoke("acme.board", "p1", "runs.start");
      j.plugins.grant("acme.board", "p1", "runs.start"); // granted again: only the generation tells the two apart
    },
  });
  const plugin = await s.connect(PLUGIN_ATT);
  const user = await s.connect("user#Uone#w1");
  const key = randomUUID();
  const challengeId = ((await plugin.call("axis.runs", "start", s.body(), key)).error?.details?.["challenge"] as Row)["challengeId"] as string;
  const listed = (await user.call("axis.approvals", "pending", {})).result?.["challenges"] as Row[];
  await user.call("axis.approvals", "resolve", { challengeId, decision: "approve", digest: listed[0]?.["digest"] });
  const done = await plugin.call("axis.runs", "start", s.body(s.ws1, { approval: { challengeId } }), key);
  assert.equal(bumped, true, "the grant changed between the spend and the handler");
  assert.equal(done.error?.code, "E_CONFLICT");
  assert.equal(reason(done), "grant_changed");
  assert.equal(s.starts.length, 0, "no run on the new generation with the old approval");
});

test("review K2 S2, the handler alone: an approval minted at one generation never starts a run at another", async (t) => {
  const s = await setup(t);
  const h = handlerRig(s);
  const asPlugin = verifier.verify(PLUGIN_ATT) as Identity;
  const approved = h.mint();
  s.journal.plugins.revoke("acme.board", "p1", "runs.start");
  s.journal.plugins.grant("acme.board", "p1", "runs.start");
  await assert.rejects(Promise.resolve(h.handlers.start(h.ctx(asPlugin, approved), s.body() as never)), (e: unknown) => (e as { code?: string; details?: Row }).code === "E_CONFLICT" && (e as { details?: Row }).details?.["reason"] === "grant_changed");
  assert.equal(h.seen.length, 0);
  await h.handlers.start(h.ctx(asPlugin, h.mint()), s.body() as never);
  assert.deepEqual(h.seen[0]?.initiator, { kind: "plugin", pluginId: "acme.board", generation: 2 }, "a fresh approval at the new generation starts");
});

test("layer: an approval for one workspace never starts a run in another workspace of the same project", async (t) => {
  const s = await setup(t);
  const h = handlerRig(s);
  const asPlugin = verifier.verify(PLUGIN_ATT) as Identity;
  await assert.rejects(Promise.resolve(h.handlers.start(h.ctx(asPlugin, h.mint()), s.body(s.ws1b) as never)), (e: unknown) => (e as { code?: string }).code === "E_NOT_FOUND");
  assert.equal(h.seen.length, 0);
});
