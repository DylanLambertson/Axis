// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Identity, PolicyInput } from "@axis/daemon";
import { contracts } from "@axis/protocol";
import { InMemoryTrustRegistry, RULES, RuleTablePolicy, WEB_MAX_TIER } from "../../src/index.js";

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

test("web policy: every row above tier 1, every per-start row and every approvals row is denied to a web client, even a trusted one", () => {
  const registry = new InMemoryTrustRegistry();
  registry.set({ windowId: "w1", workspaceId: "ws1" }, true);
  const policy = new RuleTablePolicy(registry);
  let allowed = 0;
  for (const [key, rule] of Object.entries(RULES)) {
    const web = policy.evaluate(input(key, identity("web", true))).effect;
    const desktop = policy.evaluate(input(key, identity("desktop", true))).effect;
    const readOnly = rule.tier <= WEB_MAX_TIER && rule.trust !== "per-start" && !key.startsWith("axis.approvals/");
    assert.equal(web, readOnly ? "allow" : "deny", key);
    if (readOnly) allowed++;
    if (web === "allow") assert.equal(desktop, "allow", `${key}: web never gets more than desktop`);
  }
  assert.ok(allowed > 0, "reads stay available");
  for (const key of ["axis.approvals/1.resolve", "axis.approvals/1.pending", "axis.cli-runs/1.start", "axis.cli-runs/1.stop", "axis.review/1.complete", "axis.runs/1.cancel", "axis.git/1.push", "axis.worktrees/1.create"]) {
    assert.ok(key in RULES, key);
    assert.equal(policy.evaluate(input(key, identity("web", true))).effect, "deny", key);
  }
  assert.equal(policy.evaluate(input("axis.approvals/1.pending", identity("desktop", false))).effect, "allow", "desktop is unchanged");
});

test("web policy: an unknown client kind is treated like a web client (fails closed)", () => {
  const policy = new RuleTablePolicy(new InMemoryTrustRegistry());
  const odd = { ...identity("desktop", true), clientKind: "cli" } as unknown as Identity;
  assert.equal(policy.evaluate(input("axis.approvals/1.pending", odd)).effect, "deny");
  assert.equal(policy.evaluate(input("axis.projects/1.list", odd)).effect, "allow");
});
