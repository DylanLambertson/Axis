// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTOR_PATTERN } from "@axis/audit";
import type { Identity, PolicyInput } from "@axis/daemon";
import { contracts } from "@axis/protocol";
import { InMemoryTrustRegistry, PLANNED_RULES, RULES, RuleTablePolicy } from "../../src/index.js";
import { actorOf } from "../../src/messages/audit.js";

/**
 * PV-K1a (ADR 0008 decision 3): a plugin identity exists before any plugin row does. Until PV-K1b adds the plugin table, every
 * served and planned method is denied to it, even in a project the registry trusts, so no plugin path is open by accident.
 */
const PLUGIN = { connectionId: "A".repeat(22), windowId: "p1", actorId: "plugin:acme", actor: "plugin:acme", workspaceId: "ws1", trusted: true, clientKind: "plugin", hostWindowId: "w1" } as Identity;

function input(key: string, id: Identity): PolicyInput {
  const at = key.lastIndexOf("/");
  const dot = key.indexOf(".", at);
  const method = key.slice(dot + 1);
  const spec = contracts[key.slice(0, dot)]?.[method];
  return { identity: id, contract: key.slice(0, at), version: Number(key.slice(at + 1, dot)), method, sideEffect: spec?.sideEffect ?? "read", tier: spec?.tier ?? 0 };
}

test("no row admits a plugin until PV-K1b: every served and planned method is denied, trust or not", () => {
  const registry = new InMemoryTrustRegistry();
  for (const subject of [{ windowId: "p1", workspaceId: "ws1" }, { windowId: "w1", workspaceId: "ws1" }]) registry.set(subject, true);
  for (const rules of [RULES, PLANNED_RULES]) {
    const policy = new RuleTablePolicy(registry, rules);
    const keys = Object.keys(rules);
    for (const key of keys) assert.equal(policy.evaluate(input(key, PLUGIN)).effect, "deny", key);
  }
  assert.ok(Object.keys(RULES).length > 10 && Object.keys(RULES).includes("axis.approvals/1.resolve"), "the served table, approvals included");
});

test("a plugin connection is never read as a desktop one: a user-actor identity of kind plugin gets only what a web client gets", () => {
  const registry = new InMemoryTrustRegistry();
  registry.set({ windowId: "w1", workspaceId: "ws1" }, true);
  const policy = new RuleTablePolicy(registry);
  const forged = { ...PLUGIN, actor: "user", actorId: "local-user", windowId: "w1", hostWindowId: undefined } as unknown as Identity;
  const desktop = { ...forged, clientKind: "desktop" } as Identity;
  assert.equal(policy.evaluate(input("axis.worktrees/1.create", desktop)).effect, "allow", "the same identity as a desktop one is allowed");
  assert.equal(policy.evaluate(input("axis.worktrees/1.create", forged)).effect, "deny", "as a plugin kind it is not");
  assert.equal(policy.evaluate(input("axis.approvals/1.resolve", forged)).effect, "deny");
});

test("a plugin caller is audited as plugin:<id>; an id too long for the audit actor is recorded as daemon, never a failed write", () => {
  assert.equal(actorOf({ kind: "plugin", pluginId: "acme.board", receivedHop: 0 }), "plugin:acme.board");
  const edge = "a".repeat(64);
  assert.equal(actorOf({ kind: "plugin", pluginId: edge, receivedHop: 0 }), `plugin:${edge}`);
  const long = `${"a".repeat(63)}.${"b".repeat(63)}`;
  assert.equal(actorOf({ kind: "plugin", pluginId: long, receivedHop: 0 }), "daemon");
  for (const id of ["acme.board", edge, long]) assert.match(actorOf({ kind: "plugin", pluginId: id, receivedHop: 0 }), ACTOR_PATTERN, id);
  assert.equal(actorOf({ kind: "user" }), "user");
});
