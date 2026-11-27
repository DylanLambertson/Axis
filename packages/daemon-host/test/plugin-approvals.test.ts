// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-K1e-a2-1b: the challenge gate's plugin branch. A plugin's challenge goes to its host window, the plugin learns only the id,
// the binding is checked at issue, resolve, detail and consume, and the bounds hold. Without its dependencies the branch refuses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { ApprovalError, requestDigest, type ApprovalInput, type HandlerContext } from "@axis/daemon";
import { Journal } from "@axis/journal";
import { MAX_DETAIL_PROMPT, type Challenge, type ChallengeDetail } from "@axis/protocol";
import { createApprovals, createApprovalsHandlers, type NativeControl } from "../src/index.js";
import type { PluginChallengeDeps } from "../src/gate/plugin-approvals.js";
import { fakeClock } from "./helpers.js";

type Row = Record<string, unknown>;
const control: NativeControl = { nativeConfirm: () => new Promise(() => undefined) };
const detailOf = (pluginId: string, over: Partial<ChallengeDetail> = {}): ChallengeDetail =>
  ({ kind: "runs.start", requester: { kind: "plugin", pluginId }, prompt: "Summarise the open tasks", project: "One", workspace: "feature-x", mode: "edit", provider: "anthropic", model: "claude-opus-5-5", ...over }) as ChallengeDetail;

function rig(opts: { plugins?: false; valid?: () => boolean; bind?: PluginChallengeDeps["bind"]; record?: PluginChallengeDeps["issues"]["record"]; failDetailAudit?: boolean } = {}) {
  const clock = fakeClock();
  const audit: Row[] = [];
  const records: string[] = [];
  let valid = opts.valid ?? (() => true);
  const deps: PluginChallengeDeps = {
    bind:
      opts.bind ??
      ((input) => {
        const pluginId = input.actor.slice("plugin:".length);
        return { pluginId, projectId: "p1", detail: detailOf(pluginId), valid: () => valid() };
      }),
    issues: { record: opts.record ?? ((pluginId) => (records.push(pluginId), { ok: true })) },
    now: () => clock.now(),
  };
  const approvals = createApprovals({ audit: { append: (e) => { if (opts.failDetailAudit === true && e.payload["phase"] === "detail") throw new Error("audit down"); audit.push(e as unknown as Row); } }, control, clock, ...(opts.plugins === false ? {} : { plugins: deps }) });
  const plugin = (id = "acme.board", host = "w1", conn = `P${id.replace(/\./g, "_")}`.padEnd(22, "_")): ApprovalInput => {
    const args = { workspaceId: "ws-1", mode: "edit", prompt: "Summarise the open tasks", providerId: "anthropic", modelId: "claude-opus-5-5" };
    return {
      identity: { connectionId: conn, windowId: "p7", actorId: `plugin:${id}`, actor: `plugin:${id}`, trusted: false, clientKind: "plugin", hostWindowId: host, workspaceId: "p1" },
      actor: `plugin:${id}`,
      connectionId: conn,
      requestId: "r1",
      correlationId: "x",
      contract: "axis.runs",
      contractVersion: 1,
      method: "start",
      tier: 3,
      args,
      digest: requestDigest("axis.runs", 1, "start", args),
      signal: new AbortController().signal,
    } as ApprovalInput;
  };
  const content = { target: "workspace:ws-1", contentDigest: "e".repeat(64) };
  return { approvals, plugin, content, clock, audit, records, setValid: (v: () => boolean) => void (valid = v) };
}
const user = (windowId = "w1", clientKind = "desktop") => ({ actor: "user", windowId, clientKind });
const code = (e: unknown): string | undefined => (e as { code?: string }).code;
const refuses = async (p: unknown, want: string): Promise<void> => {
  await assert.rejects(Promise.resolve(p), (e: unknown) => e instanceof ApprovalError && e.code === want);
};

test("inert: without the plugin dependencies every plugin challenge is refused before it exists; a user challenge is unchanged", async () => {
  const r = rig({ plugins: false });
  await refuses(r.approvals.gate.issue(r.plugin(), r.content), "E_POLICY_DENIED");
  assert.deepEqual([r.approvals.port.pending("w1"), r.approvals.port.pending("p7")], [[], []]);
  assert.equal(r.audit.length, 0, "no challenge was issued");
  const u = rig({ plugins: false });
  const args = { id: "ws-1" };
  const ch = (await u.approvals.gate.issue({ ...u.plugin(), identity: { connectionId: "conn-1".padEnd(22, "_"), windowId: "w1", actorId: "u", actor: "user", trusted: true, clientKind: "desktop" }, actor: "user", connectionId: "conn-1".padEnd(22, "_"), args, digest: requestDigest("axis.runs", 1, "start", args) }, u.content)) as Challenge;
  const listed = u.approvals.port.pending("w1");
  assert.equal(listed.length, 1);
  assert.equal("requester" in (listed[0] as object), false);
  assert.equal(u.approvals.port.detail(user(), ch.challengeId), undefined, "a user challenge has no detail");
});

test("routed: listed in the host window only, with the closed requester; never in the plugin view's window or another window", async () => {
  const r = rig();
  const c = (await r.approvals.gate.issue(r.plugin(), r.content)) as Challenge;
  const listed = r.approvals.port.pending("w1");
  assert.equal(listed.length, 1);
  assert.deepEqual((listed[0] as { requester?: unknown }).requester, { kind: "plugin", pluginId: "acme.board" });
  assert.deepEqual(r.approvals.port.pending("p7"), []);
  assert.deepEqual(r.approvals.port.pending("w2"), []);
  assert.equal(c.tier, 3);
  assert.equal(c.nativeConfirmationRequired, false, "tier 3: renderer-resolved, no native dialog");
  assert.deepEqual(r.records, ["acme.board"], "one issue counted");
});

test("resolve: the plugin and another window are refused; the user in the host window resolves; only the plugin's connection consumes", async () => {
  const r = rig();
  const c = (await r.approvals.gate.issue(r.plugin(), r.content)) as Challenge;
  assert.throws(() => r.approvals.port.resolve({ actor: "plugin:acme.board", windowId: "w1" }, { challengeId: c.challengeId, decision: "approve", digest: c.digest }), (e: unknown) => code(e) === "E_POLICY_DENIED");
  assert.throws(() => r.approvals.port.resolve({ actor: "user", windowId: "w2" }, { challengeId: c.challengeId, decision: "approve", digest: c.digest }), (e: unknown) => code(e) === "E_POLICY_DENIED");
  assert.equal(r.approvals.port.resolve({ actor: "user", windowId: "w1" }, { challengeId: c.challengeId, decision: "approve", digest: c.digest }).state, "approved");
  const asUser = { ...r.plugin(), identity: { ...r.plugin().identity, connectionId: "user-conn".padEnd(22, "_"), actor: "user" as const, actorId: "u", clientKind: "desktop" as const, windowId: "w1" }, actor: "user" as const, connectionId: "user-conn".padEnd(22, "_") };
  await refuses(r.approvals.gate.execute(asUser as ApprovalInput, { challengeId: c.challengeId }, r.content, () => Promise.reject(new Error("must not run"))), "E_POLICY_DENIED");
  let ran = 0;
  await r.approvals.gate.execute(r.plugin(), { challengeId: c.challengeId }, r.content, async () => (ran++, "done"));
  assert.equal(ran, 1);
});

test("binding: a change between issue and resolve ends the challenge; resolve and detail are then refused", async () => {
  const r = rig();
  const c = (await r.approvals.gate.issue(r.plugin(), r.content)) as Challenge;
  r.setValid(() => false); // a disable, revoke, generation change or the host window closing
  assert.throws(() => r.approvals.port.resolve({ actor: "user", windowId: "w1" }, { challengeId: c.challengeId, decision: "approve", digest: c.digest }));
  assert.deepEqual(r.approvals.port.pending("w1"), [], "ended, not left listed");
  assert.equal(r.approvals.port.detail(user(), c.challengeId), undefined);
  r.setValid(() => true);
  await refuses(r.approvals.gate.execute(r.plugin(), { challengeId: c.challengeId }, r.content, () => Promise.reject(new Error("must not run"))), "E_POLICY_DENIED");
});

test("binding TOCTOU: a change after the user approved and before the approval is spent refuses the spend; the action never runs", async () => {
  const r = rig();
  const c = (await r.approvals.gate.issue(r.plugin(), r.content)) as Challenge;
  assert.equal(r.approvals.port.resolve({ actor: "user", windowId: "w1" }, { challengeId: c.challengeId, decision: "approve", digest: c.digest }).state, "approved");
  r.setValid(() => false);
  let ran = 0;
  await refuses(r.approvals.gate.execute(r.plugin(), { challengeId: c.challengeId }, r.content, async () => void ran++), "E_CONFLICT");
  r.setValid(() => true);
  await assert.rejects(r.approvals.gate.execute(r.plugin(), { challengeId: c.challengeId }, r.content, async () => void ran++), ApprovalError, "the approval is gone for good");
  assert.equal(ran, 0);
});

test("detail: the user's desktop connection in the host window reads the full request; every other case gets the same nothing", async () => {
  const r = rig();
  const c = (await r.approvals.gate.issue(r.plugin(), r.content)) as Challenge;
  assert.deepEqual(r.approvals.port.detail(user(), c.challengeId), detailOf("acme.board"));
  const audited = r.audit.filter((e) => (e["payload"] as Row)["phase"] === "detail");
  assert.equal(audited.length, 1);
  const wire = JSON.stringify(audited);
  assert.ok(!wire.includes(c.challengeId) && !wire.includes("Summarise") && !wire.includes("workspace:ws-1"), "audited by reference only");
  for (const [who, id] of [[user("w2"), c.challengeId], [user("w1", "web"), c.challengeId], [{ actor: "plugin:acme.board", windowId: "w1", clientKind: "plugin" }, c.challengeId], [{ actor: "agent:composer.r1", windowId: "w1", clientKind: "desktop" }, c.challengeId], [user(), "Z".repeat(43)]] as const) {
    assert.equal(r.approvals.port.detail(who, id), undefined, JSON.stringify(who));
  }
  assert.equal(r.approvals.port.resolve({ actor: "user", windowId: "w1" }, { challengeId: c.challengeId, decision: "approve", digest: c.digest }).state, "approved");
  assert.equal(r.approvals.port.detail(user(), c.challengeId), undefined, "no longer pending");
});

test("detail is a copy: changing what one read returned does not change the next", async () => {
  const r = rig();
  const c = (await r.approvals.gate.issue(r.plugin(), r.content)) as Challenge;
  const first = r.approvals.port.detail(user(), c.challengeId) as { prompt: string };
  first.prompt = "changed";
  assert.equal((r.approvals.port.detail(user(), c.challengeId) as { prompt: string }).prompt, "Summarise the open tasks");
});

test("bounds: one open per plugin, four open per host window, freed by a withdraw, a connection close or expiry; tier 4 refused", async () => {
  const r = rig();
  const first = (await r.approvals.gate.issue(r.plugin("acme.board"), r.content)) as Challenge;
  await refuses(r.approvals.gate.issue(r.plugin("acme.board"), r.content), "E_BACKPRESSURE");
  for (const id of ["b.one", "c.two", "d.three"]) await r.approvals.gate.issue(r.plugin(id), r.content);
  await refuses(r.approvals.gate.issue(r.plugin("e.four"), r.content), "E_BACKPRESSURE");
  await r.approvals.gate.issue(r.plugin("e.four", "w2"), r.content); // another host window has its own four
  assert.deepEqual(r.records, ["acme.board", "b.one", "c.two", "d.three", "e.four"], "a refusal by a bound spends nothing of the hour");
  r.approvals.gate.withdraw?.(first.challengeId, { actor: "plugin:acme.board", connectionId: r.plugin("acme.board").connectionId });
  await r.approvals.gate.issue(r.plugin("acme.board"), r.content);
  r.approvals.gate.withdrawConnection?.(r.plugin("b.one").connectionId);
  await r.approvals.gate.issue(r.plugin("f.five"), r.content);
  r.clock.advance(60_000 + 30_000); // the challenge and any approval of it have expired
  for (const id of ["g.six", "h.seven", "i.eight", "j.nine"]) await r.approvals.gate.issue(r.plugin(id), r.content);
  await refuses(r.approvals.gate.issue({ ...r.plugin("k.ten"), tier: 4 }, r.content), "E_POLICY_DENIED");
});

test("issue refusals: no binding, a throwing bind, a binding that does not hold, another plugin's detail, an oversize prompt, the hourly counter", async () => {
  for (const [bind, want] of [
    [() => undefined, "E_POLICY_DENIED"],
    [() => { throw new Error("boom"); }, "E_POLICY_DENIED"],
    [() => ({ pluginId: "other.plugin", projectId: "p1", detail: detailOf("other.plugin"), valid: () => true }), "E_POLICY_DENIED"],
    [() => ({ pluginId: "acme.board", projectId: "p1", detail: detailOf("other.plugin"), valid: () => true }), "E_INVALID_ARGUMENT"],
    [() => ({ pluginId: "acme.board", projectId: "p1", detail: detailOf("acme.board"), valid: () => false }), "E_INVALID_ARGUMENT"],
    [() => ({ pluginId: "acme.board", projectId: "p1", detail: detailOf("acme.board", { prompt: "x".repeat(MAX_DETAIL_PROMPT + 1) }), valid: () => true }), "E_INVALID_ARGUMENT"],
    [() => ({ pluginId: "acme.board", projectId: "p1", detail: { ...detailOf("acme.board"), extra: 1 }, valid: () => true }), "E_INVALID_ARGUMENT"],
  ] as const) {
    const r = rig({ bind: bind as PluginChallengeDeps["bind"] });
    await refuses(r.approvals.gate.issue(r.plugin(), r.content), want);
    assert.deepEqual(r.approvals.port.pending("w1"), []);
    assert.deepEqual(r.records, [], "nothing counted");
  }
  const full = rig({ record: () => ({ ok: false, reason: "hourly_limit" }) });
  await refuses(full.approvals.gate.issue(full.plugin(), full.content), "E_BACKPRESSURE");
  const broken = rig({ record: () => { throw new Error("db"); } });
  await refuses(broken.approvals.gate.issue(broken.plugin(), broken.content), "E_BACKPRESSURE");
  assert.deepEqual([full.approvals.port.pending("w1"), broken.approvals.port.pending("w1")], [[], []]);
});

test("the journal's counter: six issues an hour per plugin and project, the seventh refused; a disable and enable does not reset it", async () => {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  journal.registerProject({ id: "p1", path: "/repo/one", displayName: "One", trusted: false, actor: "user" });
  journal.plugins.add("acme.board", "p1");
  const r = rig({ record: (pluginId, projectId, now) => journal.pluginIssues.record(pluginId, projectId, now) });
  for (let i = 0; i < 6; i++) {
    const c = (await r.approvals.gate.issue(r.plugin(), r.content)) as Challenge;
    r.approvals.gate.withdraw?.(c.challengeId, { actor: "plugin:acme.board", connectionId: r.plugin().connectionId });
    r.clock.advance(1);
  }
  journal.plugins.setEnabled("acme.board", "p1", true);
  journal.plugins.setEnabled("acme.board", "p1", false);
  await refuses(r.approvals.gate.issue(r.plugin(), r.content), "E_BACKPRESSURE");
  r.clock.advance(3_600_000);
  await r.approvals.gate.issue(r.plugin(), r.content);
});

test("the detail handler: user desktop only, the challenge id only, the same E_NOT_FOUND for everything else", async () => {
  const r = rig();
  const c = (await r.approvals.gate.issue(r.plugin(), r.content)) as Challenge;
  const h = createApprovalsHandlers({ approvals: r.approvals.port }).detail;
  const ctx = (identity: Row): HandlerContext => ({ identity, requestId: "r", correlationId: "x", signal: new AbortController().signal }) as unknown as HandlerContext;
  const desktop = { actor: "user", windowId: "w1", connectionId: "c".repeat(22), clientKind: "desktop" };
  assert.deepEqual(await h(ctx(desktop), { challengeId: c.challengeId } as never), { challengeId: c.challengeId, detail: detailOf("acme.board") });
  const notFound = async (identity: Row, payload: unknown, want = "E_NOT_FOUND") => assert.throws(() => h(ctx(identity), payload as never), (e: unknown) => code(e) === want, JSON.stringify(identity));
  await notFound({ ...desktop, clientKind: "web" }, { challengeId: c.challengeId });
  await notFound({ ...desktop, actor: "plugin:acme.board", clientKind: "plugin" }, { challengeId: c.challengeId });
  await notFound({ ...desktop, actor: "agent:composer.r1" }, { challengeId: c.challengeId });
  await notFound({ ...desktop, windowId: "w2" }, { challengeId: c.challengeId });
  await notFound(desktop, { challengeId: "Z".repeat(43) });
  await notFound(desktop, { challengeId: c.challengeId, windowId: "w1" }, "E_INVALID_ARGUMENT");
});

test("a binding check that throws counts as not holding", async () => {
  const r = rig();
  const c = (await r.approvals.gate.issue(r.plugin(), r.content)) as Challenge;
  r.setValid(() => { throw new Error("boom"); });
  assert.equal(r.approvals.port.detail(user(), c.challengeId), undefined);
  assert.deepEqual(r.approvals.port.pending("w1"), [], "ended");
});

test("a detail read that cannot be audited is not answered", async () => {
  const r = rig({ failDetailAudit: true });
  const c = (await r.approvals.gate.issue(r.plugin(), r.content)) as Challenge;
  assert.equal(r.approvals.port.detail(user(), c.challengeId), undefined);
});

test("defence in depth: the handler refuses a web client even when the port would answer", async () => {
  const always = { resolve: () => assert.fail("no resolve"), pending: () => [], detail: () => detailOf("acme.board") };
  const h = createApprovalsHandlers({ approvals: always as never }).detail;
  const ctx = (clientKind: string): HandlerContext => ({ identity: { actor: "user", windowId: "w1", connectionId: "c".repeat(22), clientKind }, requestId: "r", correlationId: "x", signal: new AbortController().signal }) as unknown as HandlerContext;
  assert.throws(() => h(ctx("web"), { challengeId: "C".repeat(43) } as never), (e: unknown) => code(e) === "E_NOT_FOUND");
  assert.deepEqual(await h(ctx("desktop"), { challengeId: "C".repeat(43) } as never), { challengeId: "C".repeat(43), detail: detailOf("acme.board") });
});

test("defence in depth: the plugin branch's own detail read refuses a binding that no longer holds, even while listed", async () => {
  const { PluginChallenges } = await import("../src/gate/plugin-approvals.js");
  let valid = true;
  const branch = new PluginChallenges({
    deps: { bind: () => ({ pluginId: "acme.board", projectId: "p1", detail: detailOf("acme.board"), valid: () => valid }), issues: { record: () => ({ ok: true }) }, now: () => 1 },
    monotonic: () => 1,
    lifetimeMs: 1_000,
    audit: { append() {} },
  });
  const r = rig();
  branch.prepare(r.plugin(), r.content).track("C".repeat(43));
  assert.deepEqual(branch.detail(user(), "C".repeat(43), true), detailOf("acme.board"));
  valid = false;
  assert.equal(branch.detail(user(), "C".repeat(43), true), undefined);
});
