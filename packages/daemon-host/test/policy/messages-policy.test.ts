// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The served policy rows of axis.messages/1 (planned in PV-M1, served by PV-M3) and the coverage check that holds them to the
// contract and to the handlers.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Identity, PolicyInput } from "@axis/daemon";
import { contracts, plannedContracts } from "@axis/protocol";
import { InMemoryTrustRegistry, PLANNED_RULES, RULES, RuleTablePolicy, WEB_ALLOWED, checkCoverage, coverageProblems, policySurface, servedMethods, userRule } from "../../src/index.js";

/** The design's rows: every read method has its own (review B1), reads at tier 0 or 1, user-only writes at tier 2. */
const EXPECTED: Array<[string, number]> = [
  ["send", 2], ["thread", 1], ["threads", 0], ["read", 1], ["markRead", 1], ["pause", 2], ["resume", 2], ["settings", 0], ["updateSettings", 2],
  // The CLI endpoint switch (PV-M7 slice 2): on is tier 4 (main's native dialog), off is tier 1 (a decrease).
  ["enableCliEndpoint", 4], ["disableCliEndpoint", 1],
];
const key = (m: string): string => `axis.messages/1.${m}`;
const identity = (over: Record<string, unknown> = {}): Identity =>
  ({ connectionId: "A".repeat(22), windowId: "w1", actorId: "u1", actor: "user", workspaceId: "ws1", trusted: true, clientKind: "desktop", ...over }) as unknown as Identity;
const input = (m: string, over: Record<string, unknown> = {}): PolicyInput => {
  const spec = contracts["axis.messages/1"]?.[m];
  return { identity: identity(over), contract: "axis.messages", version: 1, method: m, sideEffect: spec?.sideEffect ?? "read", tier: spec?.tier ?? 0 };
};

test("messages: one served row per method, at the contract's tier, user only, no trust condition; nothing left planned", () => {
  const methods = contracts["axis.messages/1"];
  assert.ok(methods !== undefined);
  assert.deepEqual(Object.keys(methods).sort(), EXPECTED.map(([m]) => m).sort());
  for (const [m, tier] of EXPECTED) {
    const row = RULES[key(m)];
    assert.ok(row !== undefined, `${m} has no row`);
    assert.equal(row.tier, tier, m);
    assert.equal(methods[m]?.tier, tier, `${m} contract tier`);
    assert.deepEqual(row.actors, ["user"], m);
    assert.equal(row.trust, "none", m);
    assert.equal(Object.isFrozen(row), true, m);
    assert.equal(WEB_ALLOWED.has(key(m)), false, `${m} reaches web clients`);
    if (methods[m]?.sideEffect === "read") assert.ok(row.tier <= 1, `${m}: a read above tier 1`);
  }
  assert.deepEqual(Object.keys(PLANNED_RULES).filter((k) => k.startsWith("axis.messages/")), []);
  assert.equal(plannedContracts["axis.messages/1"], undefined);
  assert.deepEqual(coverageProblems(), []);
  assert.doesNotThrow(() => checkCoverage());
});

test("messages: the user is allowed; an agent, the daemon, a malformed actor and a web client are denied", () => {
  const trust = new InMemoryTrustRegistry();
  trust.set({ windowId: "w1", workspaceId: "ws1" }, true);
  const policy = new RuleTablePolicy(trust);
  for (const [m] of EXPECTED) {
    assert.equal(policy.evaluate(input(m)).effect, "allow", m);
    for (const actor of ["agent:x", "agent:", "daemon", "User", "", null]) assert.equal(policy.evaluate(input(m, { actor })).effect, "deny", `${m} as ${String(actor)}`);
    assert.equal(policy.evaluate(input(m, { clientKind: "web", windowId: "web" })).effect, "deny", `${m} from a web client`);
  }
});

test("coverage: a missing, drifted or doubled messages row, or a served method without its handler, is caught", () => {
  const { [key("read")]: _read, ...noRead } = RULES;
  assert.match(coverageProblems({ rules: noRead }).join("\n"), /axis\.messages\/1\.read: served but has no policy rule/);
  assert.match(coverageProblems({ rules: { ...RULES, [key("thread")]: userRule(0) } }).join("\n"), /thread: rule tier 0 differs from the contract tier 1/);
  assert.match(coverageProblems({ rules: { ...RULES, [key("delete")]: userRule(2) } }).join("\n"), /delete: policy rule for no served method/);
  // Moving a row back to the planned table while the contract is served is refused.
  assert.match(coverageProblems({ planned: { [key("send")]: userRule(2) } }).join("\n"), /send: planned but already served/);
  assert.match(coverageProblems({ planned: { [key("send")]: userRule(2) } }).join("\n"), /send: both a served and a planned rule/);
  assert.match(coverageProblems({ plannedRegistry: { "axis.messages/1": contracts["axis.messages/1"]! } }).join("\n"), /send: in both the served and the planned registry/);
  // Host startup: a served method with no handler (the composition's `also: handlers`).
  const handlers = new Set([...servedMethods().keys()].filter((k) => k !== key("markRead")));
  assert.match(coverageProblems({ also: { handlers } }).join("\n"), /axis\.messages\/1\.markRead: served but missing from handlers/);
  assert.throws(() => checkCoverage({ rules: noRead }), /policy coverage/);
});

test("coverage: policySurface keeps the contract with its rows, or drops both", () => {
  const withMessages = policySurface(["axis.audit", "axis.messages"]);
  assert.deepEqual(Object.keys(withMessages.registry).sort(), ["axis.audit/1", "axis.messages/1"]);
  assert.equal(Object.keys(withMessages.rules).filter((k) => k.startsWith("axis.messages/")).length, EXPECTED.length);
  assert.deepEqual(coverageProblems(withMessages), []);
  const without = policySurface(["axis.audit"]);
  assert.equal(Object.keys(without.rules).some((k) => k.startsWith("axis.messages/")), false);
  assert.deepEqual(coverageProblems(without), []);
  assert.match(coverageProblems({ ...without, rules: { ...without.rules, [key("send")]: userRule(2) } }).join("\n"), /send: policy rule for no served method/);
});

test("the CLI endpoint switch: both methods are on the plugin deny list, so no plugin set can hold them, and a plugin is denied", async () => {
  const { PLUGIN_METHOD_SETS, pluginDenied, pluginCoverageProblems } = await import("../../src/policy/plugin-rules.js");
  for (const m of ["enableCliEndpoint", "disableCliEndpoint"]) {
    assert.equal(pluginDenied(key(m)), true, `${m} is not denied to plugins`);
    assert.equal(Object.values(PLUGIN_METHOD_SETS).some((keys) => keys.includes(key(m))), false, `${m} in a plugin set`);
    assert.match(pluginCoverageProblems(RULES, { "messages.send": [key(m)] }).join("\n"), /on the plugin deny list/, `${m}: a set naming it is caught`);
  }
  const trust = new InMemoryTrustRegistry();
  const policy = new RuleTablePolicy(trust);
  for (const m of ["enableCliEndpoint", "disableCliEndpoint"]) {
    assert.equal(policy.evaluate(input(m, { actor: "plugin:acme.board", actorId: "plugin:acme.board", clientKind: "plugin" })).effect, "deny", `${m} as a plugin`);
  }
});
