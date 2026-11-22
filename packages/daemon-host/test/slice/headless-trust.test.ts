// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createGitFixture, gitSkipReason, type GitFixture } from "../../testing/git-fixture.js";
import { TestClient, newKey, until } from "../../testing/test-client.js";
import { FAKE_CLI, awaitRun, createWorkspace, disposeHosts, registerProject, startHost, trustWindow } from "../../testing/slice-helpers.js";

/**
 * Project trust over the REAL composition (docs/design/project-registration-and-trust.md §5.4): a `projects.trust` revoke from
 * main stops the project's live runs (the composition wires `installProjectControl`'s `onRevoked` to the run stopper), and the
 * next start meets the gate: `E_CONFLICT` `untrusted`.
 */
const SUITE_TIMEOUT_MS = 240_000;

describe("headless slice: project trust", { skip: gitSkipReason(), timeout: SUITE_TIMEOUT_MS }, () => {
  let fx: GitFixture;
  let scratch: string;

  before(() => {
    fx = createGitFixture();
    scratch = mkdtempSync(join(tmpdir(), "axis-slice-trust-"));
  });
  after(async () => {
    await disposeHosts();
    fx.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  });

  test("review B S1: a revoke from main stops the running CLI run; the next start and a new agent home are refused (mutant: no onRevoked wiring)", async () => {
    const agents = [{ id: "slow", label: "Slow CLI", command: [process.execPath, FAKE_CLI], args: [join(scratch, "slow.json"), "slow"] }];
    const h = await startHost(fx, { agents });
    const sup = h.sup;
    await h.ready;
    trustWindow(sup);
    const projectId = await registerProject(sup, fx.repo);
    const user = await TestClient.open(sup);
    const ws = await createWorkspace(user, projectId, "Trusted");
    // PV-G3's new home worktree goes through the same gate (compose-serving.ts wires its admitNewHome and the create's trust hook).
    const newAgent = (name: string) => user.call("axis.agents", "create", { projectId, name, launch: { kind: "cli", entryId: "slow" }, home: { new: { name: `${name} home` } } }, newKey());
    const made = await newAgent("Trusted worker");
    assert.equal(made.ok, true, JSON.stringify(made.error));
    const started = await user.ok<{ run: { runId: string } }>("axis.cli-runs", "start", { workspaceId: ws.id, agentId: "slow" }, true);
    await awaitRun(user, started.run.runId, "RUNNING");

    // Main sends the revoke (the user's "Stop trusting" gesture); the host answers and stops the project's runs.
    const from = sup.received.length;
    sup.mux.sendControl({ type: "projects.trust", requestId: `rv-${newKey().slice(0, 8)}`, projectId, path: realpathSync(fx.repo), trusted: false });
    const reply = await sup.waitFor("projects.result", from);
    assert.equal(reply.ok, true);
    await until(async () => ["CANCELLED", "FAILED", "REVIEWING"].includes(String((await user.ok<{ run: { state: string } }>("axis.cli-runs", "get", { runId: started.run.runId })).run.state)), "the revoke stopped the run");

    const again = await user.call("axis.cli-runs", "start", { workspaceId: ws.id, agentId: "slow" }, newKey());
    assert.deepEqual([again.error?.code, (again.error?.details as { reason?: string } | undefined)?.reason], ["E_CONFLICT", "untrusted"]);
    const refused = await newAgent("Late worker");
    assert.deepEqual([refused.error?.code, (refused.error?.details as { reason?: string } | undefined)?.reason], ["E_CONFLICT", "untrusted_project"], "a new home is refused once the project is revoked (mutant: admitNewHome left on the registry)");
  });
});
