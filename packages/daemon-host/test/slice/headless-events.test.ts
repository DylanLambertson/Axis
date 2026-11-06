// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { approvalRequiredDetailsSchema, serverFrameSchema } from "@axis/protocol";
import { createGitFixture, gitSkipReason, type GitFixture } from "../../testing/git-fixture.js";
import { TestClient, newKey, until } from "../../testing/test-client.js";
import { FAKE_CLI, createWorkspace, disposeHosts, registerProject, startHost, trustWindow } from "../../testing/slice-helpers.js";

/**
 * Server-pushed events over the real composition (ticket E1, docs/design/events.md): a subscriber learns of workspace, run,
 * approval and audit-head changes without polling, every frame is a closed frame with ids and states only (no path, no
 * name, no challenge id), the approvals hint reaches only the window it belongs to, and a graceful shutdown ends the
 * subscription with `end { reason: "shutdown" }`.
 */
const SUITE_TIMEOUT_MS = 240_000;

describe("headless slice: events", { skip: gitSkipReason(), timeout: SUITE_TIMEOUT_MS }, () => {
  let fx: GitFixture;
  let scratch: string;

  before(() => {
    fx = createGitFixture();
    scratch = mkdtempSync(join(tmpdir(), "axis-slice-events-"));
  });
  after(async () => {
    await disposeHosts();
    fx.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  });

  test("workspace, run, approvals and audit hints arrive pushed, carry no path, and end at shutdown", async () => {
    const h = await startHost(fx, { agents: [{ id: "fake", label: "Fake CLI", command: [process.execPath, FAKE_CLI], args: [join(scratch, "fake.json")] }] });
    const sup = h.sup;
    await h.ready;
    trustWindow(sup);
    const projectId = await registerProject(sup, fx.repo);
    const user = await TestClient.open(sup);
    const other = await TestClient.open(sup, sup.attest({ windowId: "win-2" }));
    const sub = await user.ok<{ subscriptionId: string; epoch: string; seq: number; resumed: boolean; window: number }>("axis.events", "subscribe", { topics: ["workspaces", "runs", "approvals", "audit"] });
    const otherSub = await other.ok<{ subscriptionId: string }>("axis.events", "subscribe", { topics: ["approvals"] });
    assert.equal(sub.resumed, false);
    const events = () => user.frames.filter((f) => f.sub === sub.subscriptionId && f.event !== undefined).map((f) => f.event as Record<string, unknown>);
    // The test keeps the window open: it acknowledges every frame it has seen.
    const credit = setInterval(() => {
      const last = user.frames.filter((f) => f.sub === sub.subscriptionId).at(-1);
      if (last?.seq !== undefined) user.ack(sub.subscriptionId, last.seq);
    }, 20);
    credit.unref();
    try {
      const ws = await createWorkspace(user, projectId, "Pushed");
      await until(() => events().some((e) => e["topic"] === "workspaces" && e["workspaceId"] === ws.id), "a workspace event");
      await until(() => events().some((e) => e["topic"] === "audit"), "an audit head event");

      const started = await user.ok<{ run: { runId: string } }>("axis.cli-runs", "start", { workspaceId: ws.id, agentId: "fake" }, true);
      await until(() => events().some((e) => e["topic"] === "runs" && e["runId"] === started.run.runId && e["state"] === "REVIEWING"), "the run reaching REVIEWING");

      // Each window first gets one "first sighting" hint (docs/design/events.md section 4); count from there.
      const approvalsOf = (c: TestClient, id: string) => c.frames.filter((f) => f.sub === id && f.event?.["topic"] === "approvals").length;
      await until(() => approvalsOf(user, sub.subscriptionId) >= 1 && approvalsOf(other, otherSub.subscriptionId) >= 1, "the first-sighting hints");
      const mine = approvalsOf(user, sub.subscriptionId);
      const theirs = approvalsOf(other, otherSub.subscriptionId);
      writeFileSync(join(ws.path, "notes.txt"), "pushed\n");
      const diff = await user.ok<{ head: string; branch: string; treeHash: string }>("axis.review", "diff", { workspaceId: ws.id });
      await user.ok("axis.git", "commit", { workspaceId: ws.id, reviewedTreeHash: diff.treeHash, expectedParent: diff.head, expectedBranch: diff.branch, message: "Notes" }, true);
      const plan = await user.ok<{ tip: string; digest: string }>("axis.git", "pushPlan", { workspaceId: ws.id, remote: "origin" });
      const asked = await user.call("axis.git", "push", { workspaceId: ws.id, remote: "origin", confirmedPlan: { tip: plan.tip, digest: plan.digest } }, newKey());
      const { challenge } = approvalRequiredDetailsSchema.parse(asked.error?.details);
      await until(() => approvalsOf(user, sub.subscriptionId) > mine, "an approvals hint for the window that has the challenge");
      // The same tick looked at window 2; anything it sent there precedes this reply on that port.
      await other.ok("axis.events", "unsubscribe", { subscriptionId: otherSub.subscriptionId });
      assert.equal(approvalsOf(other, otherSub.subscriptionId), theirs, "another window's challenge is not announced to it");

      const wire = JSON.stringify(user.frames);
      for (const f of user.frames) assert.equal(serverFrameSchema.safeParse({ v: 1, ...f }).success, true, JSON.stringify(f));
      assert.equal(wire.includes(ws.path), false, "no workspace path in any frame");
      assert.equal(wire.includes(fx.repo), false, "no project path in any frame");
      assert.equal(wire.includes(challenge.challengeId), false, "no challenge id in any frame");
      assert.equal(wire.includes("Pushed"), false, "no workspace name in any frame");
    } finally {
      clearInterval(credit);
    }

    sup.mux.sendControl({ type: "shutdown" });
    await until(() => user.frames.some((f) => f.sub === sub.subscriptionId && f.end !== undefined), "the end frame");
    assert.deepEqual(user.frames.find((f) => f.end !== undefined)?.end, { reason: "shutdown" });
    assert.equal((await sup.exited).code, 0);
  });
});
