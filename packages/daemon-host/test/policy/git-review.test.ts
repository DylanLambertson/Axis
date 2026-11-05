// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The policy rows of axis.git/1 and axis.review/1 (ticket P1b), as the design's policy table states them.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Identity, PolicyInput } from "@axis/daemon";
import { contracts } from "@axis/protocol";
import { InMemoryTrustRegistry, PLANNED_RULES, RULES, RuleTablePolicy, coverageProblems, policySurface } from "../../src/index.js";

const CONN = "A".repeat(22);
const identity = (over: Record<string, unknown> = {}): Identity =>
  ({ connectionId: CONN, windowId: "w1", actorId: "u1", actor: "user", workspaceId: "ws1", trusted: true, clientKind: "desktop", ...over }) as unknown as Identity;
function input(contract: string, method: string, over: Record<string, unknown> = {}): PolicyInput {
  const spec = contracts[`${contract}/1`]?.[method];
  return { identity: identity(over), contract, version: 1, method, sideEffect: spec?.sideEffect ?? "read", tier: spec?.tier ?? 0 };
}
const registry = (): InMemoryTrustRegistry => {
  const r = new InMemoryTrustRegistry();
  r.set({ windowId: "w1", workspaceId: "ws1" }, true);
  return r;
};

const EXPECTED: Array<[string, string, number, "none" | "registry"]> = [
  ["axis.git", "pushPlan", 1, "none"],
  ["axis.git", "commit", 2, "registry"],
  ["axis.git", "push", 4, "registry"],
  ["axis.git", "compareUrl", 0, "none"],
  ["axis.review", "diff", 1, "none"],
  ["axis.review", "complete", 2, "none"],
];

test("the six rows are served rules with the design's tier and trust mode, and none is still planned", () => {
  for (const [c, m, tier, trust] of EXPECTED) {
    const key = `${c}/1.${m}`;
    assert.equal(RULES[key]?.tier, tier, key);
    assert.equal(RULES[key]?.trust, trust, key);
    assert.deepEqual(RULES[key]?.actors, ["user"], key);
    assert.equal(contracts[`${c}/1`]?.[m]?.tier, tier, `${key} contract tier`);
    assert.equal(PLANNED_RULES[key], undefined, `${key} is still planned`);
  }
  assert.deepEqual(coverageProblems(), []);
  assert.deepEqual(coverageProblems(policySurface(["axis.git", "axis.review"])), []);
  assert.deepEqual(Object.keys(PLANNED_RULES).sort(), ["axis.worktrees/1.discard", "axis.worktrees/1.setUserEditing"]);
});

test("only a user is admitted: agent, daemon, missing and malformed actors are refused on every method (DMN-3)", () => {
  const policy = new RuleTablePolicy(registry());
  for (const [c, m] of EXPECTED) {
    assert.equal(policy.evaluate(input(c, m)).effect, "allow", `${c}.${m}`);
    for (const actor of ["agent:claude", "agent:", "daemon", "User", "", 1, null, {}]) {
      assert.equal(policy.evaluate(input(c, m, { actor })).effect, "deny", `${c}.${m} as ${JSON.stringify(actor)}`);
    }
    assert.equal(policy.evaluate(input(c, m, { actor: undefined })).effect, "deny", `${c}.${m} without an actor`);
  }
});

test("commit and push need a trusted project; reads, compareUrl and complete do not", () => {
  const policy = new RuleTablePolicy(registry());
  for (const [c, m, , trust] of EXPECTED) {
    const untrusted = policy.evaluate(input(c, m, { trusted: false })).effect;
    assert.equal(untrusted, trust === "registry" ? "deny" : "allow", `${c}.${m} attested untrusted`);
    const unknownWindow = policy.evaluate(input(c, m, { windowId: "w2", workspaceId: undefined })).effect;
    assert.equal(unknownWindow, trust === "registry" ? "deny" : "allow", `${c}.${m} unknown window`);
  }
  const revoked = registry();
  revoked.set({ windowId: "w1", workspaceId: "ws1" }, false);
  for (const m of ["commit", "push"]) assert.equal(new RuleTablePolicy(revoked).evaluate(input("axis.git", m)).effect, "deny", `${m} after a revoke`);
});

test("a table that lowered the push tier below the contract's still serves tier 4, and a raised one is honoured", () => {
  const lowered = new RuleTablePolicy(registry(), { ...RULES, "axis.git/1.push": { ...RULES["axis.git/1.push"]!, tier: 1 } });
  assert.deepEqual(lowered.evaluate(input("axis.git", "push")), { effect: "allow" });
  const raised = new RuleTablePolicy(registry(), { ...RULES, "axis.git/1.commit": { ...RULES["axis.git/1.commit"]!, tier: 3 } });
  assert.deepEqual(raised.evaluate(input("axis.git", "commit")), { effect: "allow", tier: 3 });
});

test("the old names are denied: commit and push under axis.worktrees have no row", () => {
  const policy = new RuleTablePolicy(registry());
  for (const m of ["commit", "push"]) assert.equal(policy.evaluate({ ...input("axis.worktrees", "create"), method: m }).effect, "deny");
});
