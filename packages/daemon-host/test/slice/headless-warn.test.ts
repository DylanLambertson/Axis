// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { approvalRequiredDetailsSchema } from "@axis/protocol";
import { canary, createGitFixture, gitSkipReason, type GitFixture } from "../../testing/git-fixture.js";
import { TestClient, newKey, transcript, until } from "../../testing/test-client.js";
import type { TestSupervisor } from "../../testing/test-supervisor.js";
import { confirmNative, createWorkspace, disposeHosts, registerProject, startHost, trustWindow } from "../../testing/slice-helpers.js";

/**
 * Plan section 1.2 step 7, `warn` mode (the user setting of question 15): the scan mode the composition was given is the one the
 * push runs with. A finding does not block the push; it makes the plan require a confirmation, and the push then needs the
 * challenge and the native dialog like every push (the refuse-mode half is in `headless.test.ts`).
 */
/** A generous bound so a stuck step fails the suite instead of hanging CI; the steps themselves wait on conditions. */
const SUITE_TIMEOUT_MS = 240_000;

describe("headless slice: warn mode", { skip: gitSkipReason(), timeout: SUITE_TIMEOUT_MS }, () => {
  let fx: GitFixture;
  let scratch: string;
  let sup: TestSupervisor;

  before(() => {
    fx = createGitFixture();
    scratch = mkdtempSync(join(tmpdir(), "axis-slice-warn-"));
  });
  after(async () => {
    await disposeHosts();
    fx.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  });

  test("a finding asks for confirmation, names rule and path only, and the confirmed push goes out", async () => {
    const h = await startHost(fx, { scanMode: "warn" });
    sup = h.sup;
    await h.ready;
    trustWindow(sup);
    const projectId = await registerProject(sup, fx.repo);
    const user = await TestClient.open(sup);
    const secret = canary(11);
    const ws = await createWorkspace(user, projectId, "Warn");
    writeFileSync(join(ws.path, "settings.txt"), `aws_access_key_id=${secret}\n`);
    const diff = await user.ok<{ head: string; branch: string; treeHash: string }>("axis.review", "diff", { workspaceId: ws.id });
    await user.ok("axis.git", "commit", { workspaceId: ws.id, reviewedTreeHash: diff.treeHash, expectedParent: diff.head, expectedBranch: diff.branch, message: "Add settings" }, true);
    const plan = await user.ok<{ tip: string; digest: string; requiresConfirmation: boolean; reasons: string[]; findings: Array<{ rule: string; path?: string }>; blocked?: unknown }>("axis.git", "pushPlan", { workspaceId: ws.id, remote: "origin" });
    assert.equal(plan.blocked, undefined, "warn mode blocks nothing");
    assert.equal(plan.requiresConfirmation, true);
    assert.ok(plan.reasons.length > 0);
    assert.ok(plan.findings.some((f) => f.rule === "aws-access-key-id" && f.path === "settings.txt"));
    const request = { workspaceId: ws.id, remote: "origin", confirmedPlan: { tip: plan.tip, digest: plan.digest } };
    const key = newKey();
    const asked = await user.call("axis.git", "push", request, key);
    const { challenge } = approvalRequiredDetailsSchema.parse(asked.error?.details);
    await until(() => sup.nativeConfirms.some((c) => c.challengeId === challenge.challengeId), "native.confirm");
    await user.ok("axis.approvals", "resolve", { challengeId: challenge.challengeId, decision: "approve", digest: challenge.digest });
    await confirmNative(sup, user, challenge.challengeId);
    const pushed = await user.call("axis.git", "push", { ...request, approval: { challengeId: challenge.challengeId } }, key);
    assert.ok(pushed.ok);
    assert.deepEqual(fx.remoteRefs().map((r) => r.split(" ")[0]), [`refs/heads/${ws.branch}`]);
    assert.equal(transcript.some((t) => t.includes(secret)), false, "no response carries the matched text");
  });
});
