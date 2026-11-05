// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Identity, PolicyInput } from "@axis/daemon";
import type { RunsService } from "../../src/index.js";
import { contracts } from "@axis/protocol";
import {
  checkCoverage, coverageProblems, InMemoryTrustRegistry, MAX_TRUST_ENTRIES, PLANNED_RULES, RULES, RuleTablePolicy,
  policySurface, ruleKey, servedMethods, userRule,
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
    { ...base, tier: 9 }, { ...base, tier: -1 }, { ...base, tier: Number.NaN }, { ...base, contract: 5 as unknown as string },
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

test("TRU-2: a workspace revoke refuses the next create and run start, and never stops a running run", () => {
  const registry = trustedRegistry();
  const policy = new RuleTablePolicy(registry);
  // A real-shaped run service stub: one run is live, and any stop() is recorded.
  const stops: string[] = [];
  const runs = { stop: (id: string) => void stops.push(id), hasActiveRun: () => true } as unknown as RunsService;
  assert.equal(policy.evaluate(input("axis.cli-runs/1.start")).effect, "allow");
  assert.equal(policy.evaluate(input("axis.worktrees/1.create")).effect, "allow");
  registry.set({ windowId: "w1", workspaceId: "ws1" }, false);
  assert.equal(policy.evaluate(input("axis.cli-runs/1.start")).effect, "deny");
  assert.equal(policy.evaluate(input("axis.worktrees/1.create")).effect, "deny");
  assert.equal(policy.evaluate(input("axis.worktrees/1.restoreFromRunBase")).effect, "deny");
  // The running run is left alone: the revoke called nothing on the run service, and the user can still manage it.
  assert.deepEqual(stops, []);
  assert.equal(runs.hasActiveRun("ws1"), true);
  for (const m of ["stop", "get", "list"]) assert.equal(policy.evaluate(input(`axis.cli-runs/1.${m}`)).effect, "allow", m);
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

test("window and workspace levels: a revoke at either wins; a grant needs at least one level", () => {
  const r = new InMemoryTrustRegistry();
  r.set({ windowId: "w1" }, true);
  assert.equal(r.isTrusted({ windowId: "w1", workspaceId: "wa" }), true);
  r.set({ windowId: "w1", workspaceId: "wa" }, false);
  assert.equal(r.isTrusted({ windowId: "w1", workspaceId: "wa" }), false);
  assert.equal(r.isRevoked({ windowId: "w1", workspaceId: "wa" }), true);
  assert.equal(r.isTrusted({ windowId: "w1", workspaceId: "wb" }), true);
  r.set({ windowId: "w1" }, false);
  r.set({ windowId: "w1", workspaceId: "wb" }, true);
  assert.equal(r.isTrusted({ windowId: "w1", workspaceId: "wb" }), false, "a window revoke wins over a workspace grant");
  assert.equal(r.isTrusted({ windowId: "w1" }), false);
});

test("S1 (documented deviation from design 6.2): a workspace decision holds in every window", () => {
  const r = new InMemoryTrustRegistry();
  r.set({ windowId: "w1", workspaceId: "ws1" }, true);
  assert.equal(r.isTrusted({ windowId: "w2", workspaceId: "ws1" }), true, "another window sees the workspace grant");
  assert.equal(r.isTrusted({ windowId: "w2" }), false, "a bare unknown window is still untrusted");
  r.set({ windowId: "w2", workspaceId: "ws1" }, false);
  assert.equal(r.isTrusted({ windowId: "w1", workspaceId: "ws1" }), false, "a revoke from any window revokes for all");
  assert.equal(r.isRevoked({ windowId: "w3", workspaceId: "ws1" }), true);
  assert.equal(r.size, 1, "one key per workspace, not per window");
  // Through the policy: a connection attested trusted in a window main never named still needs the workspace grant.
  const p = new RuleTablePolicy(trustedRegistry());
  assert.equal(p.evaluate(input("axis.worktrees/1.create", { windowId: "w7" })).effect, "allow");
  assert.equal(p.evaluate(input("axis.worktrees/1.create", { windowId: "w7", trusted: false })).effect, "deny");
});

test("registry: malformed subjects are untrusted and revoked, and set refuses them", () => {
  const r = new InMemoryTrustRegistry();
  for (const bad of [{ windowId: "" }, { windowId: "a b" }, { windowId: "w", workspaceId: "x".repeat(65) }, { windowId: "w", workspaceId: "" }, null, { windowId: 5 }] as never[]) {
    assert.equal(r.isTrusted(bad), false);
    assert.equal(r.isRevoked(bad), true);
    assert.throws(() => r.set(bad, true), RangeError);
  }
  assert.throws(() => r.set({ windowId: "w" }, "yes" as never), RangeError);
  assert.equal(r.size, 0);
});

test("the cap: a full table refuses a new grant, evicts nothing, and keeps existing decisions", () => {
  const r = new InMemoryTrustRegistry();
  for (let i = 0; i < MAX_TRUST_ENTRIES; i++) r.set({ windowId: `w${i}` }, true);
  assert.equal(r.size, MAX_TRUST_ENTRIES);
  assert.throws(() => r.set({ windowId: "extra" }, true), /full/);
  assert.equal(r.size, MAX_TRUST_ENTRIES);
  assert.equal(r.saturated, false);
  assert.equal(r.isTrusted({ windowId: "w0" }), true, "the oldest grant is still there");
  assert.equal(r.isTrusted({ windowId: `w${MAX_TRUST_ENTRIES - 1}` }), true);
  // Updating a key it already holds is not growth, so it still works (here a revoke of the oldest grant).
  r.set({ windowId: "w0" }, false);
  assert.equal(r.isRevoked({ windowId: "w0" }), true);
  assert.equal(r.size, MAX_TRUST_ENTRIES);
});

test("the cap: a revoke that cannot be recorded latches the registry closed, and no revoke is ever evicted", () => {
  const r = new InMemoryTrustRegistry();
  r.set({ windowId: "w1", workspaceId: "bad" }, false);
  for (let i = 0; i < MAX_TRUST_ENTRIES - 1; i++) r.set({ windowId: `x${i}` }, false);
  assert.equal(r.size, MAX_TRUST_ENTRIES);
  assert.throws(() => r.set({ windowId: "one-more" }, false), /saturated/);
  assert.equal(r.saturated, true);
  assert.equal(r.size, MAX_TRUST_ENTRIES, "nothing was evicted to make room");
  // Fail closed for everyone, including a subject nobody ever revoked, and no decision (grant or revoke) is accepted.
  assert.equal(r.isRevoked({ windowId: "w1", workspaceId: "bad" }), true);
  assert.equal(r.isTrusted({ windowId: "never-seen" }), false);
  assert.equal(r.isRevoked({ windowId: "never-seen" }), true);
  assert.throws(() => r.set({ windowId: "w1" }, true), /saturated/);
  assert.throws(() => r.set({ windowId: "w1", workspaceId: "bad" }, true), /saturated/);
  // And the policy refuses everything that needs trust, including a start.
  const p = new RuleTablePolicy(r);
  for (const k of ["axis.worktrees/1.create", "axis.cli-runs/1.start"]) assert.equal(p.evaluate(input(k)).effect, "deny", k);
  assert.equal(p.evaluate(input("axis.audit/1.list")).effect, "allow");
});

test("a saturating revoke on a registry that holds grants also latches closed rather than evicting a grant", () => {
  const r = new InMemoryTrustRegistry();
  for (let i = 0; i < MAX_TRUST_ENTRIES; i++) r.set({ windowId: `w${i}` }, true);
  assert.throws(() => r.set({ windowId: "newly-revoked" }, false), /saturated/);
  assert.equal(r.isRevoked({ windowId: "newly-revoked" }), true);
  assert.equal(r.isTrusted({ windowId: "w0" }), false);
  assert.equal(r.size, MAX_TRUST_ENTRIES);
});

test("every row admits exactly the user actor", () => {
  for (const [key, rule] of [...Object.entries(RULES), ...Object.entries(PLANNED_RULES)]) assert.deepEqual(rule.actors, ["user"], key);
});

test("the policy reads the identity once: a getter that changes its answer cannot split the decision", () => {
  const registry = trustedRegistry();
  const policy = new RuleTablePolicy(registry);
  let reads = 0;
  const flip = { ...input("axis.worktrees/1.create"), get identity(): Identity { return reads++ === 0 ? identity() : identity({ actor: "agent:x" }); } };
  assert.equal(policy.evaluate(flip as PolicyInput).effect, "allow");
  assert.equal(reads, 1);
});

test("policySurface filters registry, rules and planned together, so coverage holds for any contract subset", () => {
  assert.deepEqual(coverageProblems(policySurface()), []);
  for (const ids of [["axis.audit"], ["axis.worktrees", "axis.cli-runs"], []]) {
    const surface = policySurface(ids);
    assert.deepEqual(coverageProblems(surface), [], ids.join());
    assert.ok(Object.keys(surface.rules).every((k) => ids.includes(k.slice(0, k.indexOf("/")))));
    assert.ok(Object.keys(surface.planned).every((k) => ids.includes(k.slice(0, k.indexOf("/")))));
    assert.deepEqual(Object.keys(surface.registry).map((k) => k.slice(0, k.indexOf("/"))).sort(), [...ids].sort());
    // A policy built from the filtered table denies a method of a contract that is not served.
    const p = new RuleTablePolicy(trustedRegistry(), surface.rules);
    assert.equal(p.evaluate(input("axis.providers/1.list")).effect, "deny");
  }
  assert.match(coverageProblems({ registry: policySurface(["axis.audit"]).registry }).join("\n"), /policy rule for no served method/);
});
