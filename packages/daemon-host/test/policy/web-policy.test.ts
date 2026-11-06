// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Identity, PolicyInput } from "@axis/daemon";
import { contracts } from "@axis/protocol";
import { InMemoryTrustRegistry, RULES, RuleTablePolicy, WEB_ALLOWED, WEB_WINDOW_ID, userRule } from "../../src/index.js";
import { windowIdOf } from "../../src/main/connect-broker.js";

/** docs/design/web-host-entry.md W-5: a web client is read-only and reaches no approval method, whatever it is attested with. */

const identity = (clientKind: "desktop" | "web", trusted: boolean): Identity =>
  ({ connectionId: "A".repeat(22), windowId: "w1", actorId: "u1", actor: "user", workspaceId: "ws1", trusted, clientKind }) as Identity;

function input(key: string, id: Identity): PolicyInput {
  const at = key.lastIndexOf("/");
  const dot = key.indexOf(".", at);
  const method = key.slice(dot + 1);
  const spec = contracts[key.slice(0, dot)]?.[method];
  return { identity: id, contract: key.slice(0, at), version: Number(key.slice(at + 1, dot)), method, sideEffect: spec?.sideEffect ?? "read", tier: spec?.tier ?? 0 };
}

/** The exact web reach, written out: a new method fails this test until its web reach is decided. */
const EXPECTED_WEB = [
  "axis.audit/1.list",
  "axis.audit/1.status",
  "axis.audit/1.verify",
  "axis.cli-runs/1.get",
  "axis.cli-runs/1.list",
  "axis.events/1.subscribe",
  "axis.events/1.unsubscribe",
  "axis.git/1.compareUrl",
  "axis.git/1.pushPlan",
  "axis.projects/1.list",
  "axis.providers/1.list",
  "axis.review/1.diff",
  "axis.runs/1.events",
  "axis.runs/1.get",
  "axis.runs/1.list",
  "axis.worktrees/1.list",
  "axis.worktrees/1.status",
];

test("web policy: a web client, even a trusted one, reaches exactly the listed reads of the served table", () => {
  const registry = new InMemoryTrustRegistry();
  registry.set({ windowId: "w1", workspaceId: "ws1" }, true);
  const policy = new RuleTablePolicy(registry);
  const allowed = Object.keys(RULES).filter((key) => policy.evaluate(input(key, identity("web", true))).effect === "allow").sort();
  assert.deepEqual(allowed, EXPECTED_WEB);
  assert.deepEqual([...WEB_ALLOWED].sort(), EXPECTED_WEB);
  for (const key of allowed) assert.equal(policy.evaluate(input(key, identity("desktop", true))).effect, "allow", `${key}: web never gets more than desktop`);
  for (const key of ["axis.approvals/1.resolve", "axis.approvals/1.pending", "axis.cli-runs/1.start", "axis.cli-runs/1.stop", "axis.review/1.complete", "axis.runs/1.cancel", "axis.git/1.push", "axis.worktrees/1.create"]) {
    assert.ok(key in RULES, key);
    assert.equal(policy.evaluate(input(key, identity("web", true))).effect, "deny", key);
  }
  assert.equal(policy.evaluate(input("axis.approvals/1.pending", identity("desktop", false))).effect, "allow", "desktop is unchanged");
});

test("web policy: a new method is refused to web clients by default, even a tier-0 read; a listed one that is a write is refused", () => {
  const policy = new RuleTablePolicy(new InMemoryTrustRegistry(), { "axis.notes/1.append": userRule(1), "axis.notes/1.peek": userRule(0), "axis.projects/1.list": userRule(0) });
  const call = (key: string, sideEffect: string, kind: "web" | "desktop" = "web"): string => policy.evaluate({ ...input(key, identity(kind, true)), sideEffect } as PolicyInput).effect;
  assert.equal(call("axis.notes/1.append", "write"), "deny");
  assert.equal(call("axis.notes/1.peek", "read"), "deny");
  assert.equal(call("axis.notes/1.peek", "read", "desktop"), "allow");
  assert.equal(call("axis.projects/1.list", "read"), "allow");
  for (const se of ["write", "destructive", "network", "credential", undefined]) assert.equal(call("axis.projects/1.list", se as string), "deny", String(se));
});

test("web policy: no desktop identity may use the web window id (X1b mints w<n>)", () => {
  const policy = new RuleTablePolicy(new InMemoryTrustRegistry());
  const desktopWeb = { ...identity("desktop", true), windowId: WEB_WINDOW_ID } as Identity;
  assert.equal(policy.evaluate(input("axis.projects/1.list", desktopWeb)).effect, "deny");
  assert.equal(policy.evaluate(input("axis.projects/1.list", identity("desktop", true))).effect, "allow");
  for (const n of [0, 1, 7, 123_456]) assert.notEqual(windowIdOf(n), WEB_WINDOW_ID);
  assert.match(windowIdOf(3), /^w\d+$/);
});

test("web policy: an unknown client kind is treated like a web client (fails closed)", () => {
  const policy = new RuleTablePolicy(new InMemoryTrustRegistry());
  const odd = { ...identity("desktop", true), clientKind: "cli" } as unknown as Identity;
  assert.equal(policy.evaluate(input("axis.approvals/1.pending", odd)).effect, "deny");
  assert.equal(policy.evaluate(input("axis.projects/1.list", odd)).effect, "allow");
});

test("web policy: a per-start row is denied to a web client even at tier 0 (the tier limit does not hide it)", () => {
  const policy = new RuleTablePolicy(new InMemoryTrustRegistry(), { "axis.projects/1.list": userRule(0, "per-start") });
  assert.equal(policy.evaluate(input("axis.projects/1.list", identity("web", true))).effect, "deny");
  assert.equal(policy.evaluate(input("axis.projects/1.list", identity("desktop", true))).effect, "allow");
});
