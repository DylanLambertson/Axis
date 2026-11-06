// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The policy rows of the axis.worktrees/1 methods changed by ticket P1d: finalise at tier 4, discard and setUserEditing served.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Identity, PolicyInput } from "@axis/daemon";
import { contracts } from "@axis/protocol";
import { InMemoryTrustRegistry, PLANNED_RULES, RULES, RuleTablePolicy, coverageProblems, policySurface } from "../../src/index.js";

const W = "axis.worktrees";
const identity = (over: Record<string, unknown> = {}): Identity =>
  ({ connectionId: "A".repeat(22), windowId: "w1", actorId: "u1", actor: "user", workspaceId: "ws1", trusted: true, clientKind: "desktop", ...over }) as unknown as Identity;
const input = (method: string, over: Record<string, unknown> = {}): PolicyInput => {
  const spec = contracts[`${W}/1`]?.[method];
  return { identity: identity(over), contract: W, version: 1, method, sideEffect: spec?.sideEffect ?? "read", tier: spec?.tier ?? 0 };
};
const policy = (): RuleTablePolicy => {
  const r = new InMemoryTrustRegistry();
  r.set({ windowId: "w1", workspaceId: "ws1" }, true);
  return new RuleTablePolicy(r);
};

const ROWS: Array<[string, number, "none" | "registry"]> = [
  ["finalise", 4, "none"],
  ["remove", 4, "none"],
  ["discard", 2, "registry"],
  ["setUserEditing", 2, "none"],
];

test("finalise is a tier 4 rule like remove, discard and setUserEditing are served, and none is planned", () => {
  for (const [m, tier, trust] of ROWS) {
    const key = `${W}/1.${m}`;
    assert.equal(RULES[key]?.tier, tier, key);
    assert.equal(RULES[key]?.trust, trust, key);
    assert.deepEqual(RULES[key]?.actors, ["user"], key);
    assert.equal(PLANNED_RULES[key], undefined, key);
    assert.ok((contracts[`${W}/1`]?.[m]?.tier ?? 0) <= tier, `${key}: the rule never sits below the contract`);
  }
  assert.deepEqual(coverageProblems(), []);
  assert.deepEqual(coverageProblems(policySurface([W])), []);
});

test("the decision for finalise never lowers the tier below 4 (native dialog)", () => {
  const d = policy().evaluate(input("finalise"));
  assert.equal(d.effect, "allow");
  assert.ok(d.effect === "allow" && (d.tier ?? 4) >= 4, "a raised tier is never below 4");
});

test("only a user is admitted to the new rows, and discard needs a trusted project while setUserEditing does not", () => {
  const p = policy();
  for (const [m, , trust] of ROWS) {
    for (const actor of ["agent:claude", "daemon", "", null]) {
      assert.equal(p.evaluate(input(m, { actor })).effect, "deny", `${m} as ${String(actor)}`);
    }
    assert.equal(p.evaluate(input(m, { trusted: false })).effect, trust === "registry" ? "deny" : "allow", `${m} attested untrusted`);
  }
});
