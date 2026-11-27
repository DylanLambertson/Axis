// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The overlay's approval tests fake the daemon's `axis.approvals/1.resolve` replies from one table
// (code-oss/overlay/.../daemon/test/common/axisResolveReplies.ts). This runs the real ChallengeManager for every row,
// so a fake that differs from what the daemon sends (for example a tier 4 Deny without `nativeRequired`) fails here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript6";
import { ChallengeManager } from "@axis/challenge";

const TABLE = new URL("../../code-oss/overlay/src/vs/axis/services/daemon/test/common/axisResolveReplies.ts", import.meta.url);

async function table() {
  const source = readFileSync(TABLE, "utf8");
  assert.doesNotMatch(source, /^\s*import\s/m, "the table has no imports");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return (await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`)).DAEMON_RESOLVE_REPLIES;
}

function daemonReply(row) {
  const clock = { t: 1_000_000 };
  const manager = new ChallengeManager({ audit: { append: () => undefined }, now: () => clock.t, monotonic: () => clock.t, challengeTtlMs: 10_000 });
  const challenge = manager.issue({
    contract: "axis.worktrees", version: 1, method: "discard", target: "workspace:ws-1", args: { id: "ws-1", deleteBranch: false },
    contentDigest: "ab".repeat(32), actor: "user", connectionId: "conn-1", windowId: "window-1", tier: row.tier,
  });
  assert.equal(challenge.nativeConfirmationRequired, row.nativeRequired, "the listing flag and the reply flag agree");
  if (row.late) clock.t += 10_000;
  return manager.resolve({ actor: "user", windowId: "window-1" }, { challengeId: challenge.challengeId, decision: row.decision, digest: challenge.digest });
}

test("every overlay fake resolve reply is what the real ChallengeManager answers", async () => {
  const rows = await table();
  assert.ok(rows.length >= 9);
  for (const row of rows) {
    const reply = daemonReply(row);
    assert.deepEqual({ ...reply, challengeId: "x" }, { challengeId: "x", state: row.state, nativeRequired: row.nativeRequired }, JSON.stringify(row));
  }
  for (const tier of [4, 5]) {
    assert.ok(rows.some((r) => r.tier === tier && r.decision === "deny" && !r.late), `a tier ${tier} Deny is in the table`);
  }
});
