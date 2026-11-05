// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AxisError, acquireInstanceLock } from "@axis/audit";
import { RUN_STATES, RUN_TRANSITIONS, type RunState } from "@axis/journal";
import { harness, type Harness } from "./helpers.js";

const DIR = mkdtempSync(join(tmpdir(), "axis-runs-lock-"));
const LOCK = acquireInstanceLock(DIR);
after(() => {
  LOCK.release();
  rmSync(DIR, { recursive: true, force: true });
});
const code = (c: string) => (e: unknown) => e instanceof AxisError && e.code === c;

/** A run left in `target` by a daemon that then died: made through the journal only, like a crash would leave it. */
function leave(h: Harness, wsId: string, kind: "cli" | "composer", target: RunState): string {
  const path: Record<RunState, RunState[]> = {
    QUEUED: [],
    RUNNING: ["RUNNING"],
    REVIEWING: ["RUNNING", "REVIEWING"],
    BLOCKED: ["RUNNING", "BLOCKED"],
    // COMPLETED needs the daemon-minted user principal, which only the daemon package may import; the terminal
    // states are untouched by recovery, and the status mapping for COMPLETED is covered by the pure status test.
    COMPLETED: [],
    FAILED: ["RUNNING", "FAILED"],
    CANCELLED: ["CANCELLED"],
  };
  const id = h.journal.createRun({ workspaceId: wsId, kind, createdBy: "daemon" }).value.id;
  for (const s of path[target]) h.journal.transitionRun(id, s);
  return id;
}

test("recovery from every journal state: interrupted, never resumed, and it converges", () => {
  assert.deepEqual(Object.keys(RUN_TRANSITIONS).sort(), [...RUN_STATES].sort());
  const h = harness();
  const w = h.workspace();
  const testable = RUN_STATES.filter((s) => s !== "COMPLETED");
  const cli = Object.fromEntries(testable.map((s) => [s, leave(h, w.id, "cli", s)])) as Record<RunState, string>;
  const composerQueued = leave(h, w.id, "composer", "QUEUED");
  const composerRunning = leave(h, w.id, "composer", "RUNNING");

  const report = h.supervisor.recover(LOCK);
  assert.deepEqual(report.launchesCancelled, [cli.QUEUED]);
  assert.deepEqual([...report.runsInterrupted].sort(), [cli.RUNNING, composerRunning].sort());

  const expect: Record<RunState, [RunState, string | null, string]> = {
    QUEUED: ["CANCELLED", "INTERRUPTED_BY_RESTART", "interrupted"],
    RUNNING: ["BLOCKED", "INTERRUPTED_BY_RESTART", "interrupted"],
    REVIEWING: ["REVIEWING", null, "finished"],
    BLOCKED: ["BLOCKED", null, "interrupted"],
    COMPLETED: ["COMPLETED", null, "finished"],
    FAILED: ["FAILED", null, "failed"],
    CANCELLED: ["CANCELLED", null, "killed"],
  };
  for (const s of testable) {
    const r = h.supervisor.get(cli[s]);
    assert.deepEqual([r.state, r.reason, r.status], expect[s], s);
    assert.equal(r.live, false, `${s} is not live`);
  }
  assert.equal(h.journal.getRun(composerQueued)?.state, "QUEUED", "a composer run is not this package's to touch");
  assert.equal(h.pty.spawns.length, 0, "recovery never spawns");
  assert.equal(h.supervisor.activeCount, 0);

  const seq = h.audit.head()?.seq;
  assert.throws(() => h.supervisor.recover(LOCK), code("E_CONFLICT"), "recovery is a startup step and runs once");
  assert.equal(h.audit.head()?.seq, seq, "a refused second recovery writes nothing");
  assert.equal(h.audit.verify().ok, true);
});

test("a run that was RUNNING shows interrupted before recovery, never running", () => {
  const h = harness();
  const id = leave(h, h.workspace().id, "cli", "RUNNING");
  assert.equal(h.supervisor.get(id).status, "interrupted");
  assert.equal(h.supervisor.workspaceStatus(h.journal.getRun(id)?.workspaceId ?? ""), "failed");
});

test("recovery needs a genuine held lock and is refused while any run is live", async () => {
  const h = harness();
  const w = h.workspace();
  assert.throws(() => h.supervisor.recover({ held: true } as never), code("E_INVALID_ARGUMENT"));
  await h.start(w);
  assert.throws(() => h.supervisor.recover(LOCK), code("E_CONFLICT"));
  h.supervisor.dispose();
  assert.throws(() => h.supervisor.recover(LOCK), code("E_UNAVAILABLE"));
});

test("an interrupted run can be dismissed by the user but never resumed", () => {
  const h = harness();
  const w = h.workspace();
  const id = leave(h, w.id, "cli", "RUNNING");
  h.supervisor.recover(LOCK);
  assert.throws(() => h.supervisor.discardInterrupted(h.journal.createRun({ workspaceId: w.id, kind: "cli", createdBy: "daemon" }).value.id, "user"), code("E_CONFLICT"));
  const done = h.supervisor.discardInterrupted(id, "user");
  assert.equal(done.state, "CANCELLED");
  assert.equal(done.reason, "USER_DISCARDED");
  assert.throws(() => h.supervisor.discardInterrupted(id, "user"), code("E_CONFLICT"));
  assert.throws(() => h.supervisor.discardInterrupted("nope", "user"), code("E_NOT_FOUND"));
  assert.equal(h.pty.spawns.length, 0);
  assert.ok(h.auditRows().some((r) => r.action === "cli_run.discard"));
});

test("a restart in the middle of a run: the new supervisor sees it interrupted and the worktree row untouched", async () => {
  const h = harness();
  const w = h.workspace();
  const { run } = await h.running(w);
  h.supervisor.dispose(); // the daemon goes away; the journal row stays RUNNING
  assert.equal(h.journal.getRun(run.runId)?.state, "RUNNING");
  const h2Journal = h.journal;
  const report = h2Journal.recover(LOCK);
  assert.deepEqual(report.runsInterrupted, [run.runId]);
  assert.equal(h2Journal.getWorkspace(w.id)?.state, "READY");
});
