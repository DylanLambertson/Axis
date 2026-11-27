// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { approvalRequiredDetailsSchema } from "@axis/protocol";
import { createGitFixture, gitSkipReason, type GitFixture } from "../../testing/git-fixture.js";
import { TestClient, newKey, until } from "../../testing/test-client.js";
import type { TestSupervisor } from "../../testing/test-supervisor.js";
import { FAKE_CLI, awaitRun, confirmNative, finaliseApproved, createWorkspace, disposeHosts, registerProject, startHost, trustWindow, type Workspace } from "../../testing/slice-helpers.js";

/**
 * The composed races of the headless slice (plan section 1.2 step 3 and question 19), on their own host: a run start racing a
 * finalise, and a run start racing a push. They run on the composition root, so what they prove is the composition: the worktrees,
 * git and runs handlers take ONE project mutex (the probe in `testing/slice-host.ts` reports the instance of every `run`), and the
 * run forwarder answers from the real runs binding once it exists (a finalise works after the run ended).
 */

/** A generous bound so a stuck step fails the suite instead of hanging CI; the steps themselves wait on conditions. */
const SUITE_TIMEOUT_MS = 240_000;

describe("headless slice: races", { skip: gitSkipReason(), timeout: SUITE_TIMEOUT_MS }, () => {
  let fx: GitFixture;
  let scratch: string;
  let sup: TestSupervisor;
  let user: TestClient;
  let projectId: string;

  before(async () => {
    fx = createGitFixture();
    scratch = mkdtempSync(join(tmpdir(), "axis-slice-race-"));
    const agents = [{ id: "slow", label: "Slow CLI", command: [process.execPath, FAKE_CLI], args: [join(scratch, "slow.json"), "slow"] }];
    const h = await startHost(fx, { agents, probeMutex: true });
    sup = h.sup;
    await h.ready;
    trustWindow(sup);
    projectId = await registerProject(sup, fx.repo);
    user = await TestClient.open(sup);
  });
  after(async () => {
    const root = dirname(sup.dataDir);
    await disposeHosts();
    assert.equal(existsSync(root), false, "the supervisor's temporary directory is gone");
    fx.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  });

  const mutexIds = (): Set<string> => new Set(sup.stderr.split("\n").filter((l) => l.startsWith("slice.mutex ")));

  test("a run start racing a finalise: exactly one wins, in either order, and a finalise works once the run has ended", async () => {
    const outcomes: string[] = [];
    for (const startFirst of [true, false]) {
      const ws = await createWorkspace(user, projectId, startFirst ? "Race A" : "Race B");
      const start = (): Promise<Awaited<ReturnType<TestClient["call"]>>> => user.call("axis.cli-runs", "start", { workspaceId: ws.id, agentId: "slow" }, true);
      const finalise = (): Promise<Awaited<ReturnType<TestClient["call"]>>> => finaliseApproved(sup, user, ws.id);
      const [a, b] = await Promise.all(startFirst ? [start(), finalise()] : [finalise(), start()]);
      const [started, finalised] = startFirst ? [a, b] : [b, a];
      assert.equal([started, finalised].filter((x) => x?.ok).length, 1, "a run never starts in a workspace that is being finalised, nor the reverse");
      const runs = await user.ok<{ runs: Array<{ runId: string; state: string }> }>("axis.cli-runs", "list", { workspaceId: ws.id });
      if (started?.ok) {
        assert.equal(finalised?.ok, false);
        const runId = (started.result as { run: { runId: string } }).run.runId;
        await awaitRun(user, runId, "RUNNING");
        await user.ok("axis.cli-runs", "stop", { runId }, true);
        await until(async () => ["CANCELLED", "FAILED", "REVIEWING"].includes(String((await user.ok<{ run: { state: string } }>("axis.cli-runs", "get", { runId })).run.state)), "the stopped run to end");
        // The forwarder now answers from the real supervisor: with the run ended, the finalise goes through.
        await until(async () => (await finalise()).ok, "finalise after the run ended");
        outcomes.push("start");
      } else {
        assert.equal(runs.runs.length, 0, "the finalise won: nothing was started");
        assert.equal(started?.error?.code, "E_CONFLICT");
        outcomes.push("finalise");
      }
    }
    assert.equal(outcomes.length, 2);
  });

  test("a run start racing a push settles: no deadlock, and the remote agrees with the answer", async () => {
    const ws: Workspace = await createWorkspace(user, projectId, "Race push");
    writeFileSync(join(ws.path, "note.txt"), "note\n");
    const diff = await user.ok<{ head: string; branch: string; treeHash: string }>("axis.review", "diff", { workspaceId: ws.id });
    await user.ok("axis.git", "commit", { workspaceId: ws.id, reviewedTreeHash: diff.treeHash, expectedParent: diff.head, expectedBranch: diff.branch, message: "Add note" }, true);
    const plan = await user.ok<{ tip: string; digest: string }>("axis.git", "pushPlan", { workspaceId: ws.id, remote: "origin" });
    const request = { workspaceId: ws.id, remote: "origin", confirmedPlan: { tip: plan.tip, digest: plan.digest } };
    const key = newKey();
    const asked = await user.call("axis.git", "push", request, key);
    const { challenge } = approvalRequiredDetailsSchema.parse(asked.error?.details);
    await until(() => sup.nativeConfirms.some((c) => c.challengeId === challenge.challengeId), "native.confirm");
    await user.ok("axis.approvals", "resolve", { challengeId: challenge.challengeId, decision: "approve", digest: challenge.digest });
    await confirmNative(sup, user, challenge.challengeId);
    // Both calls are in flight together: the approved push and a run start take the same project mutex, one after the other.
    const [push, started] = await Promise.all([
      user.call("axis.git", "push", { ...request, approval: { challengeId: challenge.challengeId } }, key),
      user.call("axis.cli-runs", "start", { workspaceId: ws.id, agentId: "slow" }, true),
    ]);
    const pushed = fx.remoteRefs().some((r) => r.startsWith(`refs/heads/${ws.branch} `));
    assert.equal(push.ok, pushed, "the push answered success exactly when the branch is on the remote");
    if (started.ok) {
      assert.ok(push.ok || push.error?.code === "E_CONFLICT", "a push refused for a live run is a conflict");
      // End the run and wait for it, so no CLI is still starting (and writing into the worktree) when the host is torn down.
      const runId = (started.result as { run: { runId: string } }).run.runId;
      await user.ok("axis.cli-runs", "stop", { runId }, true);
      await until(async () => ["CANCELLED", "FAILED", "REVIEWING", "BLOCKED"].includes(String((await user.ok<{ run: { state: string } }>("axis.cli-runs", "get", { runId })).run.state)), "the stopped run to end");
    }
  });

  test("the worktrees, git and runs handlers shared one project mutex", () => {
    const ids = mutexIds();
    assert.ok(ids.size > 0, "the probe saw the mutex used");
    assert.deepEqual([...ids], ["slice.mutex 1"], "one instance served create, start, finalise, commit and push");
  });
});
