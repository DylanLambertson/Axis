// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-K2 slice K2-g2: axis.plugins/1 grant and enable at tier 4 through the real daemon pipeline, approvals, native bridge and
// journal: off by default; the whole-state digest read under the project mutex at the spend; the native dialog line.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MessagePort } from "node:worker_threads";
import { test, type TestContext } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { Daemon, MemoryIdempotencyStore, memoryPair, protocolRegistry, type HandlerContext, type Identity, type IdentityVerifier, type PolicyInput } from "@axis/daemon";
import { Journal } from "@axis/journal";
import { createWorktreesApprovals, InMemoryTrustRegistry, RULES, RuleTablePolicy, createApprovalsHandlers, type NativeControl } from "../src/index.js";
import type { NativeConfirmRequest } from "../src/control/client.js";
import { createPluginsHandlers, registerPluginsHandlers } from "../src/handlers/plugins.js";
import { grantDigest } from "../src/plugins/grant-content.js";
import { DialogOverflow, grantLine, shortPluginId } from "../src/plugins/grant-line.js";
import { ProjectMutex } from "../src/worktrees/project-mutex.js";
import { Client, type Msg } from "./approvals-rig.js";
import { fakeClock } from "./helpers.js";

type Row = Record<string, unknown>;
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

async function setup(t: TestContext, over: { grantsEnabled?: boolean; projectName?: string; pluginId?: string; onAudit?: (e: Row) => Promise<void> | void } = {}) {
  const clock = fakeClock();
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  // A name the journal refuses (it checks display names) is still served to the hook through `getProject`, so the dialog line is
  // tested against every unsafe class even where the journal would never hold it.
  let shown: string | undefined;
  try {
    journal.registerProject({ id: "p1", path: "/repo/one", displayName: over.projectName ?? "One", trusted: false, actor: "user" });
  } catch {
    journal.registerProject({ id: "p1", path: "/repo/one", displayName: "One", trusted: false, actor: "user" });
    shown = over.projectName;
  }
  const view = { getProject: (id: string) => { const p = journal.getProject(id); return p === undefined ? undefined : { ...p, displayName: shown ?? p.displayName }; }, plugins: journal.plugins };
  const pluginId = over.pluginId ?? "acme.board";
  journal.plugins.add(pluginId, "p1");
  journal.plugins.grant(pluginId, "p1", "pages.read");
  // The native dialog: every request is recorded and answered when the test says so.
  const dialogs: Array<{ request: NativeConfirmRequest; answer: (confirmed: boolean) => void }> = [];
  const control: NativeControl = {
    nativeConfirm: (request) => new Promise((resolve) => dialogs.push({ request, answer: (confirmed) => resolve({ confirmed, proof: request.proof, windowId: request.windowId }) })),
  };
  const approvals = createWorktreesApprovals({ audit: { append() {} }, control, clock });
  const mutex = new ProjectMutex();
  const daemon = new Daemon({
    identity: verifier,
    audit: { append: (e) => over.onAudit?.(e as unknown as Row) as never },
    registry: protocolRegistry,
    idempotency: new MemoryIdempotencyStore(),
    policy: new RuleTablePolicy(new InMemoryTrustRegistry(), RULES, journal.plugins),
    approvals: approvals.gate,
  });
  daemon.register("axis.approvals", 1, createApprovalsHandlers({ approvals: approvals.port }));
  registerPluginsHandlers({ register: (c, v, h, o) => (o === undefined ? daemon.register(c, v, h) : daemon.register(c, v, h, o)) }, { journal: view, mutex, endPlugin: (p, j) => approvals.endPlugin(p, j), grantsEnabled: over.grantsEnabled ?? true, onPreview: approvals.onPreview });
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
  const until = async (pred: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setImmediate(r));
    assert.ok(pred(), "waited condition");
  };
  /** Ask, have main's dialog shown, approve in the window and confirm natively: the challenge id to spend. */
  const approve = async (user: Client, method: "grant" | "enable", payload: Row): Promise<string> => {
    const asked = await user.call("axis.plugins", method, payload);
    assert.equal(asked.error?.code, "E_APPROVAL_REQUIRED", JSON.stringify(asked.error));
    const challenge = asked.error?.details?.["challenge"] as Row;
    await until(() => dialogs.some((d) => d.request.challengeId === challenge["challengeId"]));
    const resolved = await user.call("axis.approvals", "resolve", { challengeId: challenge["challengeId"], decision: "approve", digest: challenge["digest"] });
    assert.equal(resolved.result?.["state"], "approved", JSON.stringify(resolved));
    dialogs.find((d) => d.request.challengeId === challenge["challengeId"])?.answer(true);
    await new Promise((r) => setImmediate(r));
    return challenge["challengeId"] as string;
  };
  return { journal, approvals, mutex, dialogs, connect, approve, pluginId, setShown: (name: string) => void (shown = name) };
}
const reasonOf = (m: Msg): unknown => m.error?.details?.["reason"];

test("off by default and in production: grant and enable are refused before any challenge or dialog", async (t) => {
  const s = await setup(t, { grantsEnabled: false });
  const user = await s.connect("user#Uone#w1");
  for (const [method, payload] of [["grant", { projectId: "p1", pluginId: "acme.board", permission: "runs.start" }], ["enable", { projectId: "p1", pluginId: "acme.board" }]] as const) {
    const res = await user.call("axis.plugins", method, payload);
    assert.equal(res.error?.code, "E_UNAVAILABLE", method);
    assert.equal(reasonOf(res), "plugin_grants_off", method);
  }
  assert.equal(s.approvals.stats().pending, 0);
  assert.equal(s.dialogs.length, 0);
  // No source of the daemon host turns them on: K2-enable is the change that will.
  const files: string[] = [];
  const walk = (dir: string): void => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p); } };
  walk(join(import.meta.dirname, "..", "..", "src"));
  assert.ok(files.length > 50);
  for (const f of files) assert.doesNotMatch(readFileSync(f, "utf8"), /pluginGrants\s*:\s*true/, f);
  // And the composition turns them on only for an explicit true: an absent or any other value is off.
  const src = (name: string): string => readFileSync(join(import.meta.dirname, "..", "..", "src", name), "utf8");
  assert.match(src("compose.ts"), /pluginGrants: options\.pluginGrants === true,/);
  assert.match(src("compose-serving.ts"), /grantsEnabled: ctx\.pluginGrants === true,/);
});

test("grant: tier 4 with main's native dialog; the exact dialog line; the write after the native confirmation only", async (t) => {
  const s = await setup(t);
  const user = await s.connect("user#Uone#w1");
  const payload = { projectId: "p1", pluginId: "acme.board", permission: "runs.start" };
  const asked = await user.call("axis.plugins", "grant", payload);
  const challenge = asked.error?.details?.["challenge"] as Row;
  assert.equal(challenge["tier"], 4);
  assert.equal(challenge["nativeConfirmationRequired"], true);
  // Before the native answer the retry is refused, and nothing is written.
  await user.call("axis.approvals", "resolve", { challengeId: challenge["challengeId"], decision: "approve", digest: challenge["digest"] });
  assert.notEqual((await user.call("axis.plugins", "grant", { ...payload, approval: { challengeId: challenge["challengeId"] } })).ok, true);
  assert.deepEqual(s.journal.plugins.state("acme.board", "p1")?.permissions, ["pages.read"]);
  assert.equal(s.dialogs[0]?.request.summary, "axis.plugins/1.grant: may ask to start AI runs: acme.board in One");
  s.dialogs[0]?.answer(true);
  await new Promise((r) => setImmediate(r));
  const done = await user.call("axis.plugins", "grant", { ...payload, approval: { challengeId: challenge["challengeId"] } });
  assert.deepEqual(done.result, { plugin: { pluginId: "acme.board", enabled: false, generation: 1, permissions: ["pages.read", "runs.start"] } }, JSON.stringify(done.error));
});

test("the native line for the longest plugin id and project name, and for every unsafe class, is whole, safe and never manifest text", async (t) => {
  const longId = `a${"b".repeat(14)}.c${"d".repeat(14)}.e${"f".repeat(14)}.g${"h".repeat(15)}`;
  assert.equal(longId.length, 64);
  for (const [label, name, pluginId] of [
    ["the longest id and name", "P".repeat(128), longId],
    ["bidi override", "One\u202eevil", "acme.board"],
    ["zero-width", "O\u200bne", "acme.board"],
    ["control", "One\u0007", "acme.board"],
    ["line separator", "One\u2028Two", "acme.board"],
    ["lone surrogate", "One\ud800", "acme.board"],
  ] as const) {
    const s = await setup(t, { projectName: name, pluginId });
    const user = await s.connect("user#Uone#w1");
    const asked = await user.call("axis.plugins", "grant", { projectId: "p1", pluginId, permission: "runs.start" });
    assert.equal(asked.error?.code, "E_APPROVAL_REQUIRED", label);
    for (let i = 0; i < 50 && s.dialogs.length === 0; i++) await new Promise((r) => setImmediate(r));
    const summary = s.dialogs[0]?.request.summary as string;
    const detail = summary.slice("axis.plugins/1.grant: ".length);
    assert.ok(summary.startsWith("axis.plugins/1.grant: may ask to start AI runs: "), `${label}: the wording is whole and first`);
    assert.ok(detail.length <= 80, `${label}: within the dialog's units`);
    assert.ok(detail.includes(shortPluginId(pluginId)), `${label}: the stable id`);
    if (label === "the longest id and name") {
      // The whole budget is used and only the project name, last, is cut: the wording and the id are whole.
      const head = `may ask to start AI runs: ${shortPluginId(longId)} in `;
      assert.equal(detail, `${head}${"P".repeat(80 - head.length - 1)}…`);
    }
    assert.doesNotMatch(summary, /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u, label);
    assert.doesNotMatch(summary, /manifest|SAFE TO APPROVE/i, label);
  }
});

test("the dialog line never drops its wording: a line whose fixed parts cannot fit is refused, never cut", () => {
  assert.throws(() => grantLine({ wording: "w".repeat(60), dangerous: true, pluginId: "acme.board", projectName: "One" }), DialogOverflow);
  // The boundary: the longest wording that still leaves the project 8 units is accepted, whole; one unit more is refused.
  // head = wording + ": " + "acme.board" + " in " = wording + 16 units, so the room is 64 - wording.
  const fits = grantLine({ wording: "w".repeat(56), dangerous: false, pluginId: "acme.board", projectName: "A long project name" });
  assert.equal(fits, `${"w".repeat(56)}: acme.board in A long …`);
  assert.equal(fits.length, 80);
  assert.throws(() => grantLine({ wording: "w".repeat(57), dangerous: false, pluginId: "acme.board", projectName: "One" }), DialogOverflow);
  const dangerous = grantLine({ wording: "may read project files", dangerous: true, pluginId: "acme.board", projectName: "One" });
  assert.equal(dangerous, "SENDS DATA OUT: may read project files: acme.board in One");
});

test("TOCTOU: a change while the spend waits for the project mutex refuses the grant (the digest is read only under the mutex)", async (t) => {
  const s = await setup(t);
  const user = await s.connect("user#Uone#w1");
  const payload = { projectId: "p1", pluginId: "acme.board", permission: "runs.start" };
  const id = await s.approve(user, "grant", payload);
  let release!: () => void;
  const held = s.mutex.run("p1", () => new Promise<void>((r) => (release = r)));
  const retry = user.call("axis.plugins", "grant", { ...payload, approval: { challengeId: id } });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  s.journal.plugins.grant("acme.board", "p1", "tasks.read"); // the state moves while the spend waits
  release();
  await held;
  const res = await retry;
  assert.notEqual(res.ok, true);
  assert.deepEqual(s.journal.plugins.state("acme.board", "p1")?.permissions, ["pages.read", "tasks.read"], "runs.start was not written");
});

test("the audit hand-off and the write are inside the mutex: a revoke sent during the execute audit row waits until the grant is done", async (t) => {
  let s: Awaited<ReturnType<typeof setup>> | undefined;
  let other: Client | undefined;
  let revoke: Promise<Msg> | undefined;
  let revokeSettledInside = false;
  s = await setup(t, {
    onAudit: async (e) => {
      if (revoke !== undefined || e["outcome"] !== "success" || e["target"] !== "axis.plugins/1.grant") return;
      revoke = (other as Client).call("axis.plugins", "revoke", { projectId: "p1", pluginId: "acme.board", permission: "pages.read" }, "c1d2e3f4-0000-4000-8000-000000000001");
      revoke.then(() => void (revokeSettledInside = !granted()));
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    },
  });
  const granted = () => (s as Awaited<ReturnType<typeof setup>>).journal.plugins.state("acme.board", "p1")?.permissions.includes("runs.start") === true;
  const user = await s.connect("user#Uone#w1");
  other = await s.connect("user#Utwo#w1");
  const payload = { projectId: "p1", pluginId: "acme.board", permission: "runs.start" };
  const id = await s.approve(user, "grant", payload);
  const done = await user.call("axis.plugins", "grant", { ...payload, approval: { challengeId: id } });
  assert.equal(done.ok, true, JSON.stringify(done.error));
  assert.ok(revoke !== undefined, "the revoke was sent during the execute audit row");
  await revoke;
  assert.equal(revokeSettledInside, false, "the revoke did not finish before the grant's write");
  assert.deepEqual(s.journal.plugins.state("acme.board", "p1")?.permissions, ["runs.start"]);
});

test("single use: a spent approval cannot grant again, not the same permission and not another", async (t) => {
  const s = await setup(t);
  const user = await s.connect("user#Uone#w1");
  const payload = { projectId: "p1", pluginId: "acme.board", permission: "runs.start" };
  const id = await s.approve(user, "grant", payload);
  assert.equal((await user.call("axis.plugins", "grant", { ...payload, approval: { challengeId: id } })).ok, true);
  assert.notEqual((await user.call("axis.plugins", "grant", { ...payload, approval: { challengeId: id } })).ok, true);
  assert.notEqual((await user.call("axis.plugins", "grant", { ...payload, permission: "files.read", approval: { challengeId: id } })).ok, true);
  assert.deepEqual(s.journal.plugins.state("acme.board", "p1")?.permissions, ["pages.read", "runs.start"]);
});

test("already_granted at issue for a grant; enable of a plugin with grants is not already_granted; enable of an enabled plugin is already_enabled", async (t) => {
  const s = await setup(t);
  const user = await s.connect("user#Uone#w1");
  const again = await user.call("axis.plugins", "grant", { projectId: "p1", pluginId: "acme.board", permission: "pages.read" });
  assert.equal(again.error?.code, "E_CONFLICT");
  assert.equal(reasonOf(again), "already_granted");
  assert.equal(s.dialogs.length, 0, "no dialog for a grant that exists");
  const id = await s.approve(user, "enable", { projectId: "p1", pluginId: "acme.board" });
  const on = await user.call("axis.plugins", "enable", { projectId: "p1", pluginId: "acme.board", approval: { challengeId: id } });
  assert.deepEqual(on.result, { plugin: { pluginId: "acme.board", enabled: true, generation: 1, permissions: ["pages.read"] } }, JSON.stringify(on.error));
  assert.equal(s.dialogs.find((d) => d.request.challengeId === id)?.request.summary, "axis.plugins/1.enable: turn on, keeping its grants: acme.board in One");
  const twice = await user.call("axis.plugins", "enable", { projectId: "p1", pluginId: "acme.board" });
  assert.equal(reasonOf(twice), "already_enabled");
});

test("policy: grant and enable are tier-4 user rows; a web client, a plugin and a worker are refused", async (t) => {
  const s = await setup(t);
  const policy = new RuleTablePolicy(new InMemoryTrustRegistry(), RULES, s.journal.plugins);
  const ask = (identity: Identity, method: string): PolicyInput => ({ identity, contract: "axis.plugins", version: 1, method, sideEffect: "write", tier: 4 });
  const desktop = verifier.verify("user#Uone#w1") as Identity;
  for (const m of ["grant", "enable"]) {
    assert.equal(RULES[`axis.plugins/1.${m}`]?.tier, 4, m);
    assert.equal(policy.evaluate(ask(desktop, m)).effect, "allow", m);
    assert.equal(policy.evaluate(ask(verifier.verify("user#Uweb#web") as Identity, m)).effect, "deny", `${m} web`);
    assert.equal(policy.evaluate(ask(verifier.verify("plugin:acme.board#Pacme#p7#w1#p1") as Identity, m)).effect, "deny", `${m} plugin`);
    assert.equal(policy.evaluate(ask({ ...desktop, actor: "agent:composer.r1", actorId: "agent:composer.r1" } as Identity, m)).effect, "deny", `${m} worker`);
  }
  const plugin = await s.connect("plugin:acme.board#Pacme#p7#w1#p1");
  assert.equal((await plugin.call("axis.plugins", "grant", { projectId: "p1", pluginId: "acme.board", permission: "runs.start" })).error?.code, "E_POLICY_DENIED");
  assert.equal(s.approvals.stats().pending, 0);
});

test("the digest: a versioned tuple over the whole state, injective where a joined string is not, type-checked", () => {
  const st = (over: Partial<{ enabled: boolean; generation: number; permissions: string[] }> = {}) => ({ enabled: false, generation: 1, permissions: ["pages.read"], ...over }) as never;
  const base = grantDigest("grant", "acme.board", "p1", "runs.start", st());
  assert.notEqual(grantDigest("grant", "a-b", "c", "runs.start", st()), grantDigest("grant", "a", "b-c", "runs.start", st()), "no separator collision");
  assert.notEqual(grantDigest("grant", "acme.board", "p1", "runs.start", st({ generation: 2 })), base, "the generation is bound");
  assert.notEqual(grantDigest("grant", "acme.board", "p1", "runs.start", st({ enabled: true })), base, "the switch is bound");
  assert.notEqual(grantDigest("grant", "acme.board", "p1", "runs.start", st({ permissions: ["pages.read", "tasks.read"] })), base, "the permission set is bound");
  assert.equal(grantDigest("grant", "acme.board", "p1", "runs.start", st({ permissions: ["tasks.read", "pages.read"] })), grantDigest("grant", "acme.board", "p1", "runs.start", st({ permissions: ["pages.read", "tasks.read"] })), "sorted");
  assert.notEqual(grantDigest("enable", "acme.board", "p1", null, st()), grantDigest("grant", "acme.board", "p1", null, st()), "the method is bound");
  assert.throws(() => grantDigest("grant", "acme.board", "p1", "runs.start", st({ generation: 1.5 })), TypeError);
  assert.notEqual(grantDigest("grant", "acme.board", "p1", "files.read", st()), base, "the permission is bound");
  assert.notEqual(grantDigest("grant", "acme.board", "p2", "runs.start", st()), base, "the project is bound");
});

test("a plugin's tier-3 run-start challenge is never native; a grant always is", async (t) => {
  const s = await setup(t);
  const user = await s.connect("user#Uone#w1");
  const asked = await user.call("axis.plugins", "grant", { projectId: "p1", pluginId: "acme.board", permission: "runs.start" });
  assert.equal((asked.error?.details?.["challenge"] as Row)["nativeConfirmationRequired"], true);
  assert.equal(RULES["axis.runs/1.start"]?.tier, 2, "the run start's own row; the plugin policy raises it to 3, below native");
});

test("the handlers themselves refuse grant and enable when grants are off, and without a spent approval, writing nothing", async (t) => {
  const s = await setup(t);
  const ctx = (approved: boolean): HandlerContext => ({ identity: verifier.verify("user#Uone#w1"), requestId: "r", correlationId: "x", signal: new AbortController().signal, ...(approved ? { approved: { target: "plugin:p1/acme.board" } } : {}) }) as unknown as HandlerContext;
  const code = (p: unknown): Promise<string> => Promise.resolve(p).then(() => "ok", (e: { code?: string; details?: Row }) => `${e.code}${e.details?.["reason"] === undefined ? "" : `:${String(e.details["reason"])}`}`);
  const grantPayload = { projectId: "p1", pluginId: "acme.board", permission: "runs.start" } as never;
  const enablePayload = { projectId: "p1", pluginId: "acme.board" } as never;
  const off = createPluginsHandlers({ journal: s.journal, mutex: s.mutex, endPlugin: () => 0, grantsEnabled: false });
  assert.equal(await code(off.grant(ctx(true), grantPayload)), "E_UNAVAILABLE:plugin_grants_off");
  assert.equal(await code(off.enable(ctx(true), enablePayload)), "E_UNAVAILABLE:plugin_grants_off");
  const on = createPluginsHandlers({ journal: s.journal, mutex: s.mutex, endPlugin: () => 0, grantsEnabled: true });
  assert.equal(await code(on.grant(ctx(false), grantPayload)), "E_NOT_FOUND");
  assert.equal(await code(on.enable(ctx(false), enablePayload)), "E_NOT_FOUND");
  assert.deepEqual(s.journal.plugins.state("acme.board", "p1"), { enabled: false, generation: 1, permissions: ["pages.read"] });
});

test("review K2-g2 N3: the dialog line is built under the project mutex, from what is read there", async (t) => {
  const s = await setup(t);
  const user = await s.connect("user#Uone#w1");
  let release!: () => void;
  const held = s.mutex.run("p1", () => new Promise<void>((r) => (release = r)));
  const asked = user.call("axis.plugins", "grant", { projectId: "p1", pluginId: "acme.board", permission: "runs.start" });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  s.setShown("Renamed"); // the name the user sees changes while the issue waits for the mutex
  release();
  await held;
  assert.equal((await asked).error?.code, "E_APPROVAL_REQUIRED");
  for (let i = 0; i < 50 && s.dialogs.length === 0; i++) await new Promise((r) => setImmediate(r));
  assert.equal(s.dialogs[0]?.request.summary, "axis.plugins/1.grant: may ask to start AI runs: acme.board in Renamed");
});

test("review K2-g2 N5: the handler re-checks already_granted and already_enabled itself, under the lock, writing nothing", async (t) => {
  const s = await setup(t);
  const h = createPluginsHandlers({ journal: s.journal, mutex: s.mutex, endPlugin: () => 0, grantsEnabled: true });
  const ctx = { identity: verifier.verify("user#Uone#w1"), requestId: "r", correlationId: "x", signal: new AbortController().signal, approved: { target: "plugin:p1/acme.board" } } as unknown as HandlerContext;
  const code = (p: unknown): Promise<string> => Promise.resolve(p).then(() => "ok", (e: { code?: string; details?: Row }) => `${e.code}:${String(e.details?.["reason"])}`);
  assert.equal(await code(h.grant(ctx, { projectId: "p1", pluginId: "acme.board", permission: "pages.read" } as never)), "E_CONFLICT:already_granted");
  s.journal.plugins.setEnabled("acme.board", "p1", true);
  assert.equal(await code(h.enable(ctx, { projectId: "p1", pluginId: "acme.board" } as never)), "E_CONFLICT:already_enabled");
  assert.deepEqual(s.journal.plugins.state("acme.board", "p1"), { enabled: true, generation: 1, permissions: ["pages.read"] });
});
