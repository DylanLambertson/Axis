// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-K1e-a2: a plugin may be a challenge's requester and consume its approval on its own connection; it never resolves one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ChallengeManager, requestDigest } from "../src/index.js";

const CONN = "Pacme_board".padEnd(22, "_");
const args = { workspaceId: "ws-1" };
function issue(actor: string) {
  const manager = new ChallengeManager({ audit: { append() {} }, now: () => 1_700_000_000_000, monotonic: () => 1 });
  const c = manager.issue({ contract: "axis.runs", version: 1, method: "start", args, requestDigest: requestDigest({ contract: "axis.runs", version: 1, method: "start", payload: args }), target: "workspace:ws-1", contentDigest: "e".repeat(64), actor, connectionId: CONN, windowId: "w1", tier: 3 });
  return { manager, c };
}
const ctx = { contract: "axis.runs", version: 1, method: "start", args, target: "workspace:ws-1", currentContentDigest: "e".repeat(64) };

test("a plugin requester: issued to the host window, resolved only by the user there, consumed only by the plugin's connection", async () => {
  const { manager, c } = issue("plugin:acme.board");
  assert.throws(() => manager.resolve({ actor: "plugin:acme.board", windowId: "w1" }, { challengeId: c.challengeId, decision: "approve", digest: c.digest }), (e: unknown) => (e as { code?: string }).code === "E_POLICY_DENIED");
  assert.equal(manager.resolve({ actor: "user", windowId: "w1" }, { challengeId: c.challengeId, decision: "approve", digest: c.digest }).state, "approved");
  await assert.rejects(manager.consume(c.challengeId, { actor: "user", connectionId: CONN }, ctx, () => 1), (e: unknown) => (e as { code?: string }).code === "E_POLICY_DENIED");
  await assert.rejects(manager.consume(c.challengeId, { actor: "plugin:other.tool", connectionId: CONN }, ctx, () => 1), (e: unknown) => (e as { code?: string }).code === "E_POLICY_DENIED");
  assert.equal(await manager.consume(c.challengeId, { actor: "plugin:acme.board", connectionId: CONN }, ctx, () => "ran"), "ran");
});

test("the plugin actor rule is the audit log's: a malformed plugin id is refused as a requester", () => {
  for (const bad of ["plugin:", "plugin:Acme", "plugin:acme..board", "plugin:1acme", `plugin:${"a".repeat(65)}`, "plugin:a.b.c.d.e", "plugin:acme_board", "plugins:acme"]) {
    assert.throws(() => issue(bad), (e: unknown) => (e as { code?: string }).code === "E_INVALID_ARGUMENT", bad);
  }
  for (const ok of ["plugin:acme", "plugin:acme.board", "plugin:a-b.c-d.e.f", `plugin:${"a".repeat(64)}`]) assert.doesNotThrow(() => issue(ok), ok);
});
