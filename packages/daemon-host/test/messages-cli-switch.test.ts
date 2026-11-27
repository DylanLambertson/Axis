// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-M7 slice 2 (axis-messages-shim.md section 7): the user's CLI endpoint switch through the real daemon pipeline, approvals,
// native bridge and journal. On is tier 4 with main's native dialog, bound to the switch's state and spent once; off is tier 1;
// both are the user's desktop connection's alone.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { MessagePort } from "node:worker_threads";
import { test, type TestContext } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { Daemon, MemoryIdempotencyStore, memoryPair, protocolRegistry, type HandlerContext, type Identity, type IdentityVerifier } from "@axis/daemon";
import { CLI_ENDPOINT_RECORD_ACTION, Journal } from "@axis/journal";
import { createMessagingBinding, createWorktreesApprovals, InMemoryTrustRegistry, RULES, RuleTablePolicy, createApprovalsHandlers, type NativeControl } from "../src/index.js";
import type { NativeConfirmRequest } from "../src/control/client.js";
import { createMessagesHandlers, registerMessagesHandlers } from "../src/handlers/messages.js";
import { createCliEndpointSwitchAction } from "../src/messages/cli-endpoint-action.js";
import { CLI_ENDPOINT_LINE, CLI_ENDPOINT_TARGET, cliEndpointDigest } from "../src/messages/cli-endpoint-content.js";
import { ProjectMutex } from "../src/worktrees/project-mutex.js";
import { Client, type Msg } from "./approvals-rig.js";
import { fakeClock } from "./helpers.js";
import { switchMintOf, switchOnForTests } from "./cli-endpoint-for-tests.js";

type Row = Record<string, unknown>;
const verifier: IdentityVerifier = {
  verify(att) {
    if (typeof att !== "string") return undefined;
    const [actor, conn, windowId, host, project] = att.split("#");
    if (actor?.startsWith("plugin:") === true) {
      return { connectionId: (conn as string).padEnd(22, "_"), windowId: windowId as string, actorId: actor, actor: actor as Identity["actor"], workspaceId: project as string, trusted: false, clientKind: "plugin", hostWindowId: host } as Identity;
    }
    return { connectionId: (conn as string).padEnd(22, "_"), windowId: windowId as string, actorId: "user-id", actor: "user", trusted: true, clientKind: windowId === "web" ? "web" : "desktop" };
  },
};

async function setup(t: TestContext, over: { platform?: NodeJS.Platform } = {}) {
  const clock = fakeClock();
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db);
  const journal = Journal.open(db, { audit });
  const dialogs: Array<{ request: NativeConfirmRequest; answer: (confirmed: boolean) => void }> = [];
  const control: NativeControl = {
    nativeConfirm: (request) => new Promise((resolve) => dialogs.push({ request, answer: (confirmed) => resolve({ confirmed, proof: request.proof, windowId: request.windowId }) })),
  };
  const approvals = createWorktreesApprovals({ audit: { append() {} }, control, clock });
  const daemon = new Daemon({
    identity: verifier,
    audit: { append: () => undefined },
    registry: protocolRegistry,
    idempotency: new MemoryIdempotencyStore(),
    policy: new RuleTablePolicy(new InMemoryTrustRegistry(), RULES, journal.plugins),
    approvals: approvals.gate,
  });
  daemon.register("axis.approvals", 1, createApprovalsHandlers({ approvals: approvals.port }));
  const m = createMessagingBinding({ journal, audit: { append: () => undefined }, random: { bytes: (n) => randomBytes(n) }, monotonic: () => 0, scan: async () => [], holdsSecret: () => false });
  const cliSwitch = {
    action: createCliEndpointSwitchAction(journal.cliEndpoint, switchMintOf(journal.cliEndpoint)),
    store: journal.cliEndpoint,
    mutex: new ProjectMutex(),
    platform: over.platform ?? "linux",
    onPreview: approvals.onPreview,
  };
  registerMessagesHandlers({ register: (c, v, h, o) => (o === undefined ? daemon.register(c, v, h) : daemon.register(c, v, h, o)) }, { service: m.service, settings: m.settings, cliSwitch });
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
  /** Ask, have main's dialog shown, approve in the window: the challenge (main's native answer is the test's to give). */
  const ask = async (user: Client): Promise<Row> => {
    const asked = await user.call("axis.messages", "enableCliEndpoint", {});
    assert.equal(asked.error?.code, "E_APPROVAL_REQUIRED", JSON.stringify(asked.error));
    const challenge = asked.error?.details?.["challenge"] as Row;
    await until(() => dialogs.some((d) => d.request.challengeId === challenge["challengeId"]));
    const resolved = await user.call("axis.approvals", "resolve", { challengeId: challenge["challengeId"], decision: "approve", digest: challenge["digest"] });
    assert.equal(resolved.result?.["state"], "approved", JSON.stringify(resolved));
    return challenge;
  };
  const records = () => audit.list({ limit: 100 }).filter((e) => e.action === CLI_ENDPOINT_RECORD_ACTION);
  return { journal, approvals, dialogs, connect, ask, records, cliSwitch, m };
}
const reasonOf = (m: Msg): unknown => m.error?.details?.["reason"];
const spend = (challenge: Row) => ({ approval: { challengeId: challenge["challengeId"] } });

test("enable: tier 4 with main's native dialog, the exact line; nothing is written before the native confirmation; once after it", async (t) => {
  const s = await setup(t);
  const user = await s.connect("user#Uone#w1");
  const challenge = await s.ask(user);
  assert.equal(challenge["tier"], 4);
  assert.equal(challenge["nativeConfirmationRequired"], true);
  assert.notEqual((await user.call("axis.messages", "enableCliEndpoint", spend(challenge))).ok, true, "refused before the native answer");
  assert.equal(s.journal.cliEndpoint.enabled(), false, "and nothing was written");
  assert.equal(s.dialogs.length, 1);
  assert.equal(s.dialogs[0]?.request.summary, `axis.messages/1.enableCliEndpoint: ${CLI_ENDPOINT_LINE}`);
  assert.ok(CLI_ENDPOINT_LINE.length <= 80, "the dialog's detail bound");
  s.dialogs[0]?.answer(true);
  await new Promise((r) => setImmediate(r));
  const done = await user.call("axis.messages", "enableCliEndpoint", spend(challenge));
  assert.deepEqual(done.result, { enabled: true, changed: true }, JSON.stringify(done.error));
  assert.equal(s.journal.cliEndpoint.enabled(), true);
  assert.deepEqual(s.records().map((e) => e.payload), [{ field: "cli_endpoint", enabled: true }], "one journal event");
  s.journal.registerProject({ id: "p1", path: "/repo/one", displayName: "One", trusted: false, actor: "user" });
  const settings = await user.call("axis.messages", "settings", { projectId: "p1" });
  assert.equal(settings.result?.["cliEndpoint"], true, `settings answers the switch: ${JSON.stringify(settings.error)}`);
  // The approval is single use: its replay is refused and writes nothing.
  assert.notEqual((await user.call("axis.messages", "enableCliEndpoint", spend(challenge))).ok, true, "a replay");
  assert.equal(s.records().length, 1);
});

test("enable: refused before any challenge or dialog when already on, and on Windows", async (t) => {
  const on = await setup(t);
  switchOnForTests(on.journal.cliEndpoint);
  const user = await on.connect("user#Uone#w1");
  const res = await user.call("axis.messages", "enableCliEndpoint", {});
  assert.equal(res.error?.code, "E_CONFLICT");
  assert.equal(reasonOf(res), "already_enabled");
  assert.equal(on.approvals.stats().pending, 0);
  assert.equal(on.dialogs.length, 0);
  const win = await setup(t, { platform: "win32" });
  const wuser = await win.connect("user#Utwo#w1");
  const w = await wuser.call("axis.messages", "enableCliEndpoint", {});
  assert.equal(w.error?.code, "E_UNAVAILABLE");
  assert.equal(reasonOf(w), "endpoint_unavailable");
  assert.equal(win.dialogs.length, 0);
});

test("enable: switched on between the dialog and the spend, the spend is refused (the digest is over the state, read under the switch mutex)", async (t) => {
  const s = await setup(t);
  const user = await s.connect("user#Uone#w1");
  const challenge = await s.ask(user);
  assert.notEqual(cliEndpointDigest(false), cliEndpointDigest(true), "the digest is over the state");
  switchOnForTests(s.journal.cliEndpoint); // another enable got there first
  s.dialogs[0]?.answer(true);
  await new Promise((r) => setImmediate(r));
  const done = await user.call("axis.messages", "enableCliEndpoint", spend(challenge));
  assert.notEqual(done.ok, true, JSON.stringify(done));
  assert.equal(s.records().length, 1, "only the first enable wrote");
});

test("disable: tier 1, at once, no dialog; a repeat changes nothing", async (t) => {
  const s = await setup(t);
  switchOnForTests(s.journal.cliEndpoint);
  const user = await s.connect("user#Uone#w1");
  const off = await user.call("axis.messages", "disableCliEndpoint", {});
  assert.deepEqual(off.result, { enabled: false, changed: true }, JSON.stringify(off.error));
  assert.equal(s.journal.cliEndpoint.enabled(), false);
  assert.equal(s.dialogs.length, 0);
  assert.deepEqual((await user.call("axis.messages", "disableCliEndpoint", {})).result, { enabled: false, changed: false });
  assert.equal(s.records().length, 2, "the test's enable and the one change");
});

test("only the user's desktop connection: a web client, a plugin and a worker are refused for both methods, and nothing changes", async (t) => {
  // A worker never connects over this bridge (its tools go through the broker); its identity is judged by the policy rows here.
  const policy = new RuleTablePolicy(new InMemoryTrustRegistry(), RULES);
  const worker = { ...(verifier.verify("user#Uone#w1") as Identity), actor: "agent:w1" } as Identity;
  for (const method of ["enableCliEndpoint", "disableCliEndpoint"]) {
    const spec = { enableCliEndpoint: 4, disableCliEndpoint: 1 }[method] as number;
    assert.equal(policy.evaluate({ identity: worker, contract: "axis.messages", version: 1, method, sideEffect: "write", tier: spec }).effect, "deny", `a worker: ${method}`);
  }
  const s = await setup(t);
  switchOnForTests(s.journal.cliEndpoint);
  for (const att of ["user#Uweb#web", "plugin:acme.board#Pacme#p7#w1#p1"]) {
    const c = await s.connect(att);
    for (const method of ["enableCliEndpoint", "disableCliEndpoint"]) {
      const res = await c.call("axis.messages", method, {});
      assert.notEqual(res.ok, true, `${att} ${method}`);
      assert.notEqual(res.error?.code, "E_APPROVAL_REQUIRED", `${att} ${method}: no challenge`);
    }
  }
  assert.equal(s.journal.cliEndpoint.enabled(), true, "nothing switched off");
  assert.equal(s.dialogs.length, 0);
});

test("the handlers refuse again behind the policy: another caller, no approval, an approval for another target", async (t) => {
  const s = await setup(t);
  const h = createMessagesHandlers({ service: s.m.service, settings: s.m.settings, cliSwitch: s.cliSwitch });
  const ctx = (identity: Partial<Identity>, approved?: { target: string }): HandlerContext =>
    ({ identity: { actor: "user", clientKind: "desktop", ...identity }, requestId: "q", correlationId: "k", signal: new AbortController().signal, ...(approved === undefined ? {} : { approved: { method: "enableCliEndpoint", requester: "u", ...approved } }) }) as unknown as HandlerContext;
  const code = async (p: unknown): Promise<unknown> => Promise.resolve(p).then(() => "ok", (e: { code?: string; details?: { reason?: string } }) => `${e.code}:${e.details?.reason ?? ""}`);
  assert.equal(await code(h.enableCliEndpoint(ctx({}), {} as never)), "E_NOT_FOUND:not_found", "no spent approval");
  assert.equal(await code(h.enableCliEndpoint(ctx({}, { target: "plugin:p1/acme.board" }), {} as never)), "E_NOT_FOUND:not_found", "an approval for another target");
  for (const id of [{ actor: "plugin:acme.board", clientKind: "plugin" }, { clientKind: "web" }, { actor: "agent:w1" }] as Partial<Identity>[]) {
    assert.equal(await code(h.enableCliEndpoint(ctx(id, { target: CLI_ENDPOINT_TARGET }), {} as never)), "E_NOT_FOUND:not_found", JSON.stringify(id));
    assert.equal(await code(h.disableCliEndpoint(ctx(id), {} as never)), "E_NOT_FOUND:not_found", JSON.stringify(id));
  }
  assert.equal(s.journal.cliEndpoint.enabled(), false);
  assert.equal(await code(h.enableCliEndpoint(ctx({}, { target: CLI_ENDPOINT_TARGET }), {} as never)), "ok", "inside a spent approval for this target");
  assert.equal(s.journal.cliEndpoint.enabled(), true);
  // With no switch wired, both refuse.
  const none = createMessagesHandlers({ service: s.m.service, settings: s.m.settings });
  assert.equal(await code(none.disableCliEndpoint(ctx({}), {} as never)), "E_UNAVAILABLE:endpoint_unavailable");
});
