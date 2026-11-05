// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Identity, PolicyInput } from "@axis/daemon";
import { contracts } from "@axis/protocol";
import {
  checkCoverage, coverageProblems, InMemoryTrustRegistry, MAX_TRUST_ENTRIES, PLANNED_RULES, RULES, RuleTablePolicy,
  ruleKey, servedMethods, userRule,
} from "../../src/index.js";

const CONN = "A".repeat(22);
function identity(over: Partial<Identity> = {}): Identity {
  const id: Record<string, unknown> = { connectionId: CONN, windowId: "w1", actorId: "u1", actor: "user", workspaceId: "ws1", trusted: true, clientKind: "desktop", ...over };
  if (id["workspaceId"] === undefined) delete id["workspaceId"];
  return id as unknown as Identity;
}
function input(key: string, over: Partial<Identity> = {}, tier?: number): PolicyInput {
  const at = key.lastIndexOf("/");
  const dot = key.indexOf(".", at);
  const contract = key.slice(0, at);
  const method = key.slice(dot + 1);
  const spec = contracts[key.slice(0, dot)]?.[method];
  return { identity: identity(over), contract, version: Number(key.slice(at + 1, dot)), method, sideEffect: spec?.sideEffect ?? "read", tier: tier ?? spec?.tier ?? 0 };
}
const trustedRegistry = (): InMemoryTrustRegistry => {
  const r = new InMemoryTrustRegistry();
  r.set({ windowId: "w1", workspaceId: "ws1" }, true);
  return r;
};

test("coverage: the served registry and the rule table are the same set with the same tiers", () => {
  assert.deepEqual(coverageProblems(), []);
  checkCoverage();
  assert.ok(servedMethods().size >= 17);
});

test("coverage: a method with no rule, a rule with no method, a tier drift and a stale planned row are all caught", () => {
  const { "axis.audit/1.verify": _gone, ...missing } = RULES;
  assert.match(coverageProblems({ rules: missing }).join("\n"), /axis\.audit\/1\.verify: served but has no policy rule/);
  assert.throws(() => checkCoverage({ rules: missing }), /policy coverage/);
  const extra = { ...RULES, "axis.worktrees/1.teleport": userRule(0) };
  assert.match(coverageProblems({ rules: extra }).join("\n"), /teleport: policy rule for no served method/);
  assert.match(coverageProblems({ rules: { ...RULES, "axis.worktrees/1.remove": userRule(3) } }).join("\n"), /remove: rule tier 3 differs/);
  assert.match(coverageProblems({ planned: { ...PLANNED_RULES, "axis.audit/1.list": userRule(1) } }).join("\n"), /planned but already served/);
  assert.match(coverageProblems({ also: { handlers: new Set(["axis.audit/1.list"]) } }).join("\n"), /missing from handlers/);
  assert.match(coverageProblems({ also: { handlers: new Set([...servedMethods().keys(), "axis.x/1.y"]) } }).join("\n"), /axis\.x\/1\.y: in handlers but not served/);
});

test("coverage: a tier 3 or above method is never allowed without the contract declaring it", () => {
  for (const [key, tier] of servedMethods()) assert.equal(RULES[key]?.tier, tier, key);
  assert.equal(RULES["axis.worktrees/1.remove"]?.tier, 4);
});

test("every served method allows a trusted user and refuses agent, daemon and malformed actors", () => {
  const policy = new RuleTablePolicy(trustedRegistry());
  for (const key of servedMethods().keys()) {
    assert.equal(policy.evaluate(input(key)).effect, "allow", key);
    for (const actor of ["daemon", "agent:builder", "agent:", "User", "", "root", "agent:x/../y"]) {
      assert.equal(policy.evaluate(input(key, { actor: actor as Identity["actor"] })).effect, "deny", `${key} as ${actor}`);
    }
    assert.equal(policy.evaluate(input(key, { actor: undefined as never })).effect, "deny");
  }
});

test("unknown methods, contracts and versions, planned methods and garbage inputs are denied", () => {
  const policy = new RuleTablePolicy(trustedRegistry());
  const base = input("axis.audit/1.list");
  for (const bad of [
    { ...base, method: "nope" }, { ...base, contract: "axis.nope" }, { ...base, version: 2 }, { ...base, version: 1.5 },
    { ...base, method: "__proto__" }, { ...base, method: "constructor" }, { ...base, method: "toString" },
    { ...base, tier: 9 }, { ...base, tier: Number.NaN }, { ...base, contract: 5 as unknown as string },
    { ...base, identity: null as unknown as Identity }, null as unknown as PolicyInput, undefined as unknown as PolicyInput,
  ]) assert.equal(policy.evaluate(bad).effect, "deny");
  for (const key of Object.keys(PLANNED_RULES)) assert.equal(policy.evaluate(input(key)).effect, "deny", key);
  assert.equal(ruleKey("axis.audit", 1, "list"), "axis.audit/1.list");
});

test("a throwing identity getter is a denial, not an exception", () => {
  const policy = new RuleTablePolicy(trustedRegistry());
  const hostile = { ...input("axis.audit/1.list"), get identity(): Identity { throw new Error("x"); } };
  assert.equal(policy.evaluate(hostile as PolicyInput).effect, "deny");
});

test("the policy raises a tier above the contract minimum and never lowers it", () => {
  const raised = new RuleTablePolicy(trustedRegistry(), { ...RULES, "axis.audit/1.list": userRule(3) });
  assert.deepEqual(raised.evaluate(input("axis.audit/1.list")), { effect: "allow", tier: 3 });
  const lowered = new RuleTablePolicy(trustedRegistry(), { ...RULES, "axis.worktrees/1.remove": userRule(1) });
  assert.deepEqual(lowered.evaluate(input("axis.worktrees/1.remove")), { effect: "allow" });
  assert.deepEqual(new RuleTablePolicy(trustedRegistry()).evaluate(input("axis.worktrees/1.remove")), { effect: "allow" });
});

test("registry-trust methods need the attested flag AND the live registry; an unknown window is untrusted", () => {
  const registry = trustedRegistry();
  const policy = new RuleTablePolicy(registry);
  for (const key of ["axis.worktrees/1.create", "axis.worktrees/1.restoreFromRunBase"]) {
    assert.equal(policy.evaluate(input(key)).effect, "allow", key);
    assert.equal(policy.evaluate(input(key, { trusted: false })).effect, "deny", `${key} attested false`);
    assert.equal(policy.evaluate(input(key, { windowId: "w2", workspaceId: undefined as never })).effect, "deny", `${key} unknown window`);
  }
  assert.equal(new RuleTablePolicy(new InMemoryTrustRegistry()).evaluate(input("axis.worktrees/1.create")).effect, "deny");
  assert.equal(new RuleTablePolicy(new InMemoryTrustRegistry()).evaluate(input("axis.worktrees/1.list")).effect, "allow");
});

test("TRU-2: a revoke refuses the next create and the next run start, and does not touch a running run", () => {
  const registry = trustedRegistry();
  const policy = new RuleTablePolicy(registry);
  assert.equal(policy.evaluate(input("axis.cli-runs/1.start")).effect, "allow");
  let stops = 0;
  const running = { stop: () => void stops++ }; // the registry has no way to reach this; the assertion below proves it
  registry.set({ windowId: "w1", workspaceId: "ws1" }, false);
  assert.equal(policy.evaluate(input("axis.cli-runs/1.start")).effect, "deny");
  assert.equal(policy.evaluate(input("axis.worktrees/1.create")).effect, "deny");
  // A run already going is managed only through stop/get/list, which a revoke does not gate.
  assert.equal(policy.evaluate(input("axis.cli-runs/1.stop")).effect, "allow");
  assert.equal(policy.evaluate(input("axis.cli-runs/1.get")).effect, "allow");
  assert.equal(stops, 0);
  void running;
  // Re-granting is a fresh decision.
  registry.set({ windowId: "w1", workspaceId: "ws1" }, true);
  assert.equal(policy.evaluate(input("axis.cli-runs/1.start")).effect, "allow");
});

test("run start does not need a registry grant (the per-start attestation is the authority) but an explicit revoke wins", () => {
  const empty = new InMemoryTrustRegistry();
  const policy = new RuleTablePolicy(empty);
  assert.equal(policy.evaluate(input("axis.cli-runs/1.start")).effect, "allow");
  empty.set({ windowId: "w1" }, false);
  assert.equal(policy.evaluate(input("axis.cli-runs/1.start")).effect, "deny");
});

test("trust is per project: a project revoke beats a window grant, and other projects are unaffected", () => {
  const r = new InMemoryTrustRegistry();
  r.set({ windowId: "w1" }, true);
  assert.equal(r.isTrusted({ windowId: "w1", projectId: "pa" }), true);
  r.set({ windowId: "w1", projectId: "pa" }, false);
  assert.equal(r.isTrusted({ windowId: "w1", projectId: "pa" }), false);
  assert.equal(r.isRevoked({ windowId: "w1", projectId: "pa" }), true);
  assert.equal(r.isTrusted({ windowId: "w1", projectId: "pb" }), true);
  r.set({ windowId: "w1" }, false);
  r.set({ windowId: "w1", projectId: "pb" }, true);
  assert.equal(r.isTrusted({ windowId: "w1", projectId: "pb" }), false, "a window revoke wins over a project grant");
  assert.equal(r.isTrusted({ windowId: "w9", projectId: "pb" }), true, "another window sees only its own levels plus the project grant");
});

test("registry: malformed subjects are untrusted and revoked; set refuses them; entries are bounded", () => {
  const r = new InMemoryTrustRegistry();
  for (const bad of [{ windowId: "" }, { windowId: "a b" }, { windowId: "w", workspaceId: "x".repeat(65) }, { windowId: "w", projectId: "" }, null, { windowId: 5 }] as never[]) {
    assert.equal(r.isTrusted(bad), false);
    assert.equal(r.isRevoked(bad), true);
    assert.throws(() => r.set(bad, true), RangeError);
  }
  assert.throws(() => r.set({ windowId: "w" }, "yes" as never), RangeError);
  for (let i = 0; i < MAX_TRUST_ENTRIES; i++) r.set({ windowId: `w${i}` }, true);
  assert.throws(() => r.set({ windowId: "extra" }, true), /full/);
  r.set({ windowId: "extra" }, false); // a revoke always lands
  assert.equal(r.isRevoked({ windowId: "extra" }), true);
  assert.equal(r.isTrusted({ windowId: "extra" }), false);
  assert.equal(r.isTrusted({ windowId: "w1" }), true);
});
