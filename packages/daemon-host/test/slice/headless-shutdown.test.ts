// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createGitFixture, gitSkipReason, type GitFixture } from "../../testing/git-fixture.js";
import { TestClient, until } from "../../testing/test-client.js";
import type { TestSupervisor } from "../../testing/test-supervisor.js";
import { FAKE_CLI, auditRows, awaitRun, createWorkspace, disposeHosts, openStopped, registerProject, startHost, trustWindow } from "../../testing/slice-helpers.js";

/** A generous bound so a stuck step fails the suite instead of hanging CI; the steps themselves wait on conditions. */
const SUITE_TIMEOUT_MS = 240_000;

/**
 * Design section 8, steps 3 and 4, on the composed host: (3) nothing writes after the final anchor, also not a CLI run that ends
 * while the acknowledgement is awaited, and (4) an anchor the supervisor never acknowledged is reported by the exit code (1).
 */
describe("headless slice: shutdown", { skip: gitSkipReason(), timeout: SUITE_TIMEOUT_MS }, () => {
  let fx: GitFixture;
  let scratch: string;

  before(() => {
    fx = createGitFixture();
    scratch = mkdtempSync(join(tmpdir(), "axis-slice-down-"));
  });
  after(async () => {
    await disposeHosts();
    fx.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  });

  const stop = async (sup: TestSupervisor) => {
    if (process.platform === "win32") sup.shutdown();
    else sup.kill("SIGTERM");
    return sup.exited;
  };
  const boot = async (agents: unknown, breakPutFile?: string) => {
    const h = await startHost(fx, { agents, ...(breakPutFile === undefined ? {} : { breakPutFile }) });
    await h.ready;
    trustWindow(h.sup);
    const projectId = await registerProject(h.sup, fx.repo);
    return { sup: h.sup, projectId, client: await TestClient.open(h.sup) };
  };

  test("a run that ends while the final anchor is awaited writes nothing after it", async () => {
    const release = join(scratch, "release");
    const { sup, projectId, client } = await boot([{ id: "gate", label: "Gate CLI", command: [process.execPath, FAKE_CLI], args: [join(scratch, "gate.json"), "until-file", release] }]);
    const ws = await createWorkspace(client, projectId, "Shutdown");
    const started = await client.ok<{ run: { runId: string } }>("axis.cli-runs", "start", { workspaceId: ws.id, agentId: "gate" }, true);
    await awaitRun(client, started.run.runId, "RUNNING");
    await until(() => sup.anchorPuts.length > 0, "the first anchor");
    sup.holdAcks = true; // the final put will wait for its acknowledgement
    client.close();
    const exited = stop(sup);
    writeFileSync(release, "go"); // the CLI would now end by itself, during the wait
    await new Promise((r) => setTimeout(r, 300)); // only gives a late write the chance to happen; the assertions do not depend on it
    const last = sup.anchorPuts[sup.anchorPuts.length - 1];
    assert.ok(last !== undefined);
    sup.holdAcks = false;
    sup.ack(last.seq, last.hash);
    const exit = await exited;
    assert.ok(exit.code === 0 || exit.code === 1, "the host ended");
    const db = openStopped(sup.dataDir, join(scratch, "stopped-a"));
    const rows = auditRows(db);
    db.close();
    assert.equal(rows[rows.length - 1]?.seq, last.seq, "the final anchor covers the last event: nothing was written after it");
  });

  test("a final anchor the supervisor never acknowledges exits 1, without a forced exit", async () => {
    const { sup, client, projectId } = await boot([]);
    await createWorkspace(client, projectId, "Unacked");
    await until(() => sup.anchorPuts.length > 0, "the first anchor");
    sup.holdAcks = true;
    await client.ok("axis.cli-runs", "list", {}); // more audited writes that nothing acknowledges
    client.close();
    const exit = await stop(sup);
    assert.deepEqual(exit, { code: 1, signal: null });
    assert.ok(!sup.stderr.includes("slice.forced_exit"), "the store was released: it ended by draining");
  });

  test("a final anchor that cannot be sent exits 1, without a forced exit or a hang", async () => {
    const broken = join(scratch, "break-put");
    const { sup, client, projectId } = await boot([], broken);
    await createWorkspace(client, projectId, "Unsent");
    await until(() => sup.anchorPuts.length > 0, "the first anchor");
    writeFileSync(broken, "x"); // from now on no anchor can be sent
    await client.ok("axis.cli-runs", "list", {}); // rows that no put covers
    client.close();
    const exit = await stop(sup);
    assert.deepEqual(exit, { code: 1, signal: null });
    assert.ok(!sup.stderr.includes("slice.forced_exit"), "the store was released: it ended by draining");
  });
});
