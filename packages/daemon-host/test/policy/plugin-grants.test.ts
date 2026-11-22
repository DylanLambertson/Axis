// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-K1b (ADR 0008 decisions 4 and 6): the plugin allow-list, its second fence, and the policy's plugin branch.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HandlerContext, Identity, PolicyInput } from "@axis/daemon";
import { contracts } from "@axis/protocol";
import { createPagesHandlers } from "../../src/handlers/pages.js";
import {
  InMemoryTrustRegistry,
  PLUGIN_DENY_METHODS,
  PLUGIN_METHOD_SETS,
  RULES,
  RuleTablePolicy,
  WEB_ALLOWED,
  checkPluginCoverage,
  pluginCoverageProblems,
  type PluginGrantReader,
} from "../../src/index.js";

const PLUGIN = { connectionId: "A".repeat(22), windowId: "p7", actorId: "plugin:acme.board", actor: "plugin:acme.board", workspaceId: "proj", trusted: false, clientKind: "plugin", hostWindowId: "w3" } as Identity;

function input(key: string, id: Identity = PLUGIN): PolicyInput {
  const at = key.lastIndexOf("/");
  const dot = key.indexOf(".", at);
  const method = key.slice(dot + 1);
  const spec = contracts[key.slice(0, dot)]?.[method];
  return { identity: id, contract: key.slice(0, at), version: Number(key.slice(at + 1, dot)), method, sideEffect: spec?.sideEffect ?? "read", tier: spec?.tier ?? 0 };
}
const reader = (permissions: string[], enabled = true, pluginId = "acme.board", projectId = "proj"): PluginGrantReader & { asked: string[] } => {
  const asked: string[] = [];
  return { asked, state: (p, q) => (asked.push(`${p}@${q}`), p === pluginId && q === projectId ? { enabled, permissions } : undefined) };
};
const policyWith = (r?: PluginGrantReader, registry = new InMemoryTrustRegistry(), sets?: Readonly<Record<string, readonly string[]>>) => new RuleTablePolicy(registry, RULES, r, ...(sets === undefined ? [] : [sets]) as []);

test("the shipped plugin sets are sound: served, never denied, below tier 4; startup would fail otherwise", () => {
  assert.deepEqual(pluginCoverageProblems(), []);
  checkPluginCoverage();
  for (const [bad, why] of [
    [{ "pages.read": ["axis.pages/1.nope"] }, "not served"],
    [{ "pages.write": ["axis.pages/1.markReviewed"] }, "on the plugin deny list"],
    [{ "agents.read": ["axis.approvals/1.pending"] }, "on the plugin deny list"],
    [{ "agents.read": ["axis.worktrees/1.finalise"] }, "tier 4 or more"],
    [{ "agents.read": ["axis.git/1.push"] }, "tier 4 or more"],
  ] as const) {
    assert.ok(pluginCoverageProblems(RULES, bad).some((p) => p.includes(why)), `${JSON.stringify(bad)} -> ${why}`);
    assert.throws(() => checkPluginCoverage(RULES, bad), /plugin policy coverage/);
  }
});

test("every set is exactly decision 6's: page and task user-only operations, run cancel, events and CLI starts are in none", () => {
  const all = new Set(Object.values(PLUGIN_METHOD_SETS).flat());
  for (const key of PLUGIN_DENY_METHODS) assert.equal(all.has(key), false, key);
  assert.deepEqual([...PLUGIN_METHOD_SETS["pages.write"]], ["axis.pages/1.create", "axis.pages/1.update"]);
  assert.deepEqual([...PLUGIN_METHOD_SETS["runs.start"]], ["axis.runs/1.start"]);
  assert.deepEqual([...PLUGIN_METHOD_SETS["tasks.write"]], [], "no tasks contract is served yet");
});

test("a granted, enabled plugin reaches exactly its sets; everything else is denied", () => {
  const policy = policyWith(reader(["pages.read", "messages.send"]));
  const allowed = Object.keys(RULES).filter((k) => policy.evaluate(input(k)).effect === "allow").sort();
  assert.deepEqual(allowed, [...PLUGIN_METHOD_SETS["messages.send"], ...PLUGIN_METHOD_SETS["pages.read"]].sort());
});

test("unknown, ungranted and disabled plugins get the same refusal; no reader denies everything", () => {
  const refusals = [
    policyWith(reader(["pages.read"], true, "other.one")).evaluate(input("axis.pages/1.list")),
    policyWith(reader(["pages.write"])).evaluate(input("axis.pages/1.list")),
    policyWith(reader(["pages.read"], false)).evaluate(input("axis.pages/1.list")),
    policyWith(reader(["pages.read"], true, "acme.board", "elsewhere")).evaluate(input("axis.pages/1.list")),
    policyWith(undefined).evaluate(input("axis.pages/1.list")),
  ];
  for (const r of refusals) assert.deepEqual(r, { effect: "deny" });
});

test("a plugin never falls through to the user rows or the web fence, even on a web-allowed read", () => {
  const policy = policyWith(reader([]));
  for (const key of WEB_ALLOWED) assert.equal(policy.evaluate(input(key)).effect, "deny", key);
  const userActorPluginKind = { ...PLUGIN, actor: "user", actorId: "local-user" } as Identity;
  assert.equal(policyWith(reader(["pages.read"])).evaluate(input("axis.pages/1.list", userActorPluginKind)).effect, "deny", "a user actor of kind plugin");
  const pluginActorDesktop = { ...PLUGIN, clientKind: "desktop" } as Identity;
  assert.equal(policyWith(reader(["pages.read"])).evaluate(input("axis.pages/1.list", pluginActorDesktop)).effect, "deny", "a plugin actor of kind desktop");
});

test("the deny list holds at run time even if a set named a denied method", () => {
  const sets = { "pages.write": ["axis.pages/1.markReviewed", "axis.pages/1.create"] };
  const policy = policyWith(reader(["pages.write"]), new InMemoryTrustRegistry(), sets);
  assert.equal(policy.evaluate(input("axis.pages/1.markReviewed")).effect, "deny");
  assert.equal(policy.evaluate(input("axis.pages/1.create")).effect, "allow");
  const tier4 = policyWith(reader(["agents.read"]), new InMemoryTrustRegistry(), { "agents.read": ["axis.worktrees/1.remove", "axis.agents/1.list"] });
  assert.equal(tier4.evaluate(input("axis.worktrees/1.remove")).effect, "deny", "a tier-4 method");
});

test("tiers: a plugin run start is raised to 3; a read keeps its tier; nothing reaches 4", () => {
  const policy = policyWith(reader(["runs.start", "pages.read"]));
  assert.deepEqual(policy.evaluate(input("axis.runs/1.start")), { effect: "allow", tier: 3 });
  assert.deepEqual(policy.evaluate(input("axis.pages/1.list")), { effect: "allow" });
  assert.equal(policyWith(reader(["pages.read"]), new InMemoryTrustRegistry(), { "pages.read": ["axis.pages/1.markReviewed"] }).evaluate(input("axis.pages/1.markReviewed")).effect, "deny");
});

test("trust: a gated row keeps its mode; a revoke of the view's or the host window refuses the plugin", () => {
  for (const w of ["p7", "w3"]) {
    const registry = new InMemoryTrustRegistry();
    registry.set({ windowId: w }, false); // a window-level revoke, so each window is checked on its own
    assert.equal(policyWith(reader(["runs.start"]), registry).evaluate(input("axis.runs/1.start")).effect, "deny", w);
  }
  assert.equal(policyWith(reader(["runs.start"])).evaluate(input("axis.runs/1.start")).effect, "allow");
  const registry = new InMemoryTrustRegistry();
  registry.set({ windowId: "w3", workspaceId: "proj" }, false);
  assert.equal(policyWith(reader(["pages.read"]), registry).evaluate(input("axis.pages/1.list")).effect, "allow", "an ungated read is not a trust row");
});

test("handlers stay closed: a policy allow for a plugin still ends E_NOT_FOUND at the handler, and the service is never called", async () => {
  assert.equal(policyWith(reader(["pages.read"])).evaluate(input("axis.pages/1.list")).effect, "allow");
  let called = 0;
  const service = new Proxy({}, { get: () => () => (called++, { pages: [] }) }) as never;
  const handlers = createPagesHandlers(service);
  const ctx = { identity: PLUGIN, signal: new AbortController().signal, requestId: "r", correlationId: "c" } as unknown as HandlerContext;
  await assert.rejects(Promise.resolve().then(() => handlers.list(ctx, { projectId: "proj" } as never)), (e: unknown) => (e as { code?: string }).code === "E_NOT_FOUND");
  assert.equal(called, 0);
});
