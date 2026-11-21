// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The planned policy rows of axis.messages/1 (ticket PV-M1) and the coverage check that holds them to the planned contract.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Identity, PolicyInput } from "@axis/daemon";
import { contracts, plannedContracts } from "@axis/protocol";
import { InMemoryTrustRegistry, PLANNED_RULES, RULES, RuleTablePolicy, checkCoverage, coverageProblems, policySurface, userRule } from "../../src/index.js";

/** The design's rows: every read method has its own (review B1), reads at tier 0 or 1, user-only writes at tier 2. */
const EXPECTED: Array<[string, number]> = [
  ["send", 2], ["thread", 1], ["threads", 0], ["read", 1], ["markRead", 1], ["pause", 2], ["resume", 2], ["settings", 0], ["updateSettings", 2],
];
const key = (m: string): string => `axis.messages/1.${m}`;
const identity = (over: Record<string, unknown> = {}): Identity =>
  ({ connectionId: "A".repeat(22), windowId: "w1", actorId: "u1", actor: "user", workspaceId: "ws1", trusted: true, clientKind: "desktop", ...over }) as unknown as Identity;
const input = (m: string, over: Record<string, unknown> = {}): PolicyInput => {
  const spec = plannedContracts["axis.messages/1"]?.[m];
  return { identity: identity(over), contract: "axis.messages", version: 1, method: m, sideEffect: spec?.sideEffect ?? "read", tier: spec?.tier ?? 0 };
};

test("messages: one planned row per method, at the contract's tier, user only, no trust condition, none served", () => {
  const methods = plannedContracts["axis.messages/1"];
  assert.ok(methods !== undefined);
  assert.deepEqual(Object.keys(methods).sort(), EXPECTED.map(([m]) => m).sort());
  for (const [m, tier] of EXPECTED) {
    const row = PLANNED_RULES[key(m)];
    assert.ok(row !== undefined, `${m} has no row`);
    assert.equal(row.tier, tier, m);
    assert.equal(methods[m]?.tier, tier, `${m} contract tier`);
    assert.deepEqual(row.actors, ["user"], m);
    assert.equal(row.trust, "none", m);
    assert.equal(Object.isFrozen(row), true, m);
    assert.equal(RULES[key(m)], undefined, `${m} is served`);
    if (methods[m]?.sideEffect === "read") assert.ok(row.tier <= 1, `${m}: a read above tier 1`);
  }
  assert.equal(contracts["axis.messages/1"], undefined);
  assert.deepEqual(coverageProblems(), []);
  assert.doesNotThrow(() => checkCoverage());
});

test("messages: until PV-M3 serves it, every method is denied, to the user as to an agent", () => {
  const trust = new InMemoryTrustRegistry();
  trust.set({ windowId: "w1", workspaceId: "ws1" }, true);
  const policy = new RuleTablePolicy(trust);
  for (const [m] of EXPECTED) {
    for (const actor of ["user", "agent:x", "daemon"]) assert.equal(policy.evaluate(input(m, { actor })).effect, "deny", `${m} as ${actor}`);
  }
  // Built from the planned rows, the policy would admit only the user: the rows themselves are not the gap.
  const served = new RuleTablePolicy(trust, { ...RULES, ...PLANNED_RULES });
  for (const [m] of EXPECTED) {
    assert.equal(served.evaluate(input(m)).effect, "allow", m);
    for (const actor of ["agent:x", "agent:", "daemon", "User", "", null]) assert.equal(served.evaluate(input(m, { actor })).effect, "deny", `${m} as ${String(actor)}`);
  }
});

test("coverage: a missing, extra, drifted or doubled messages row is caught in both directions", () => {
  const { [key("read")]: _read, ...noRead } = PLANNED_RULES;
  assert.match(coverageProblems({ planned: noRead }).join("\n"), /axis\.messages\/1\.read: planned method has no planned rule/);
  const { [key("markRead")]: _mark, ...noMark } = PLANNED_RULES;
  assert.match(coverageProblems({ planned: noMark }).join("\n"), /markRead: planned method has no planned rule/);
  assert.match(coverageProblems({ planned: { ...PLANNED_RULES, [key("thread")]: userRule(0) } }).join("\n"), /thread: planned rule tier 0 differs from the contract tier 1/);
  assert.match(coverageProblems({ planned: { ...PLANNED_RULES, [key("send")]: userRule(1) } }).join("\n"), /send: planned rule tier 1 differs/);
  assert.match(coverageProblems({ planned: { ...PLANNED_RULES, [key("delete")]: userRule(2) } }).join("\n"), /delete: planned rule for no planned method/);
  assert.match(coverageProblems({ planned: { ...PLANNED_RULES, "axis.tasks/1.list": userRule(0) } }).join("\n"), /axis\.tasks\/1\.list: planned rule for no planned method/);
  // Served too early: a served row without the contract, and the contract served while its rows stay planned.
  assert.match(coverageProblems({ rules: { ...RULES, [key("send")]: userRule(2) } }).join("\n"), /send: policy rule for no served method/);
  assert.match(coverageProblems({ rules: { ...RULES, [key("send")]: userRule(2) } }).join("\n"), /send: both a served and a planned rule/);
  const both = { ...contracts, "axis.messages/1": plannedContracts["axis.messages/1"]! };
  assert.match(coverageProblems({ registry: both }).join("\n"), /axis\.messages\/1\.send: in both the served and the planned registry/);
  assert.match(coverageProblems({ registry: both }).join("\n"), /axis\.messages\/1\.thread: served but has no policy rule/);
  assert.throws(() => checkCoverage({ planned: noRead }), /policy coverage/);
});

test("coverage: policySurface keeps the planned contract with its rows, or drops both", () => {
  const withMessages = policySurface(["axis.audit", "axis.messages"]);
  assert.deepEqual(Object.keys(withMessages.plannedRegistry), ["axis.messages/1"]);
  assert.equal(Object.keys(withMessages.planned).length, EXPECTED.length);
  assert.deepEqual(coverageProblems(withMessages), []);
  const without = policySurface(["axis.audit"]);
  assert.deepEqual(Object.keys(without.plannedRegistry), []);
  assert.deepEqual(Object.keys(without.planned), []);
  assert.deepEqual(coverageProblems(without), []);
  // A surface that kept the rows but dropped the contract (or the reverse) is caught.
  assert.match(coverageProblems({ ...without, planned: PLANNED_RULES }).join("\n"), /planned rule for no planned method/);
  assert.match(coverageProblems({ ...without, plannedRegistry: plannedContracts }).join("\n"), /planned method has no planned rule/);
});
