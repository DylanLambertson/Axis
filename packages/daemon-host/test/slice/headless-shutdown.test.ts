// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
/** The host waits this long for the acknowledgement the test holds; the test releases it by condition, so this only has to outlast a loaded machine. */
const HELD_ACK_WAIT_MS = 120_000;

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

  /** Whether a process still exists (signal 0 only probes). */
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const stop = async (sup: TestSupervisor) => {
    if (process.platform === "win32") sup.shutdown();
    else sup.kill("SIGTERM");
    return sup.exited;
  };
  const boot = async (agents: unknown, breakPutFile?: string, finalWaitMs?: number, config?: Record<string, unknown>) => {
    const h = await startHost(fx, { agents, ...(breakPutFile === undefined ? {} : { breakPutFile }), ...(finalWaitMs === undefined ? {} : { finalWaitMs }), ...(config === undefined ? {} : { config }) });
    await h.ready;
    trustWindow(h.sup);
    const projectId = await registerProject(h.sup, fx.repo);
    return { sup: h.sup, projectId, client: await TestClient.open(h.sup) };
  };

  test("a run that ends while the final anchor is awaited writes nothing after it", async () => {
    const release = join(scratch, "release");
    const dump = join(scratch, "gate.json");
    const { sup, projectId, client } = await boot([{ id: "gate", label: "Gate CLI", command: [process.execPath, FAKE_CLI], args: [dump, "until-file", release] }], undefined, HELD_ACK_WAIT_MS);
    const ws = await createWorkspace(client, projectId, "Shutdown");
    const started = await client.ok<{ run: { runId: string } }>("axis.cli-runs", "start", { workspaceId: ws.id, agentId: "gate" }, true);
    await awaitRun(client, started.run.runId, "RUNNING");
    await until(() => existsSync(dump) && sup.anchorPuts.length > 0, "the CLI's pid file and the first anchor");
    const cliPid = (JSON.parse(readFileSync(dump, "utf8")) as { pid: number }).pid;
    sup.holdAcks = true; // the final put will wait for its acknowledgement
    client.close();
    const exited = stop(sup);
    writeFileSync(release, "go"); // the CLI ends now (by itself or killed by the host), while the acknowledgement is awaited
    await until(() => !alive(cliPid), "the CLI process to be gone"); // a condition, not a delay
    // Whichever put was the final one, it is the newest the host ever sent (the anchor manager is halted): nothing may follow it.
    sup.holdAcks = false;
    const newest = () => sup.anchorPuts[sup.anchorPuts.length - 1];
    assert.ok(newest() !== undefined);
    try {
      sup.ack(newest()!.seq, newest()!.hash); // a put that arrives later is acknowledged on arrival
    } catch (e) {
      // Only a closed channel is expected: the host has nothing left to wait for and is ending (its exit is awaited below).
      if (!/channel is closed/i.test(String((e as { message?: unknown }).message))) throw e;
    }
    const exit = await exited;
    assert.ok(exit.code === 0 || exit.code === 1, "the host ended");
    const last = newest();
    assert.ok(last !== undefined);
    const db = openStopped(sup.dataDir, join(scratch, "stopped-a"));
    const rows = auditRows(db);
    db.close();
    assert.equal(rows[rows.length - 1]?.seq, last.seq, "the final anchor covers the last event: nothing was written after it");
  });

  test("a stall that ends with the final acknowledgement appends no row after the final anchor", async () => {
    // Shutdown step 3 halts the anchor manager: the acknowledgement of the final put ends a stall, and without the halt that
    // transition appends an audit row after the final anchor (the final anchor would no longer be the last row).
    const { sup, client, projectId } = await boot([], undefined, HELD_ACK_WAIT_MS, { limits: { anchorMaxLagEvents: 4 } });
    await createWorkspace(client, projectId, "Stalled");
    await until(() => sup.anchorPuts.length > 0, "the first anchor");
    sup.holdAcks = true;
    const status = () => client.ok<{ stalled: boolean }>("axis.audit", "status", {});
    await until(async () => (await client.ok("axis.cli-runs", "list", {}), (await status()).stalled), "the anchor to stall");
    client.close();
    const exited = stop(sup);
    sup.holdAcks = false; // the final put is acknowledged on arrival: that acknowledgement ends the stall
    const old = sup.anchorPuts[sup.anchorPuts.length - 1];
    try {
      if (old !== undefined) sup.ack(old.seq, old.hash);
    } catch (e) {
      if (!/channel is closed/i.test(String((e as { message?: unknown }).message))) throw e;
    }
    const exit = await exited;
    assert.ok(exit.code === 0 || exit.code === 1, "the host ended");
    const last = sup.anchorPuts[sup.anchorPuts.length - 1];
    assert.ok(last !== undefined);
    const db = openStopped(sup.dataDir, join(scratch, "stopped-stall"));
    const rows = auditRows(db);
    db.close();
    assert.equal(rows[rows.length - 1]?.seq, last.seq, "the final anchor is the last row: the end of the stall wrote nothing after it");
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
