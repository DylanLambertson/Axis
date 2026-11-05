// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { newKey, type Client } from "./approvals-rig.js";
import { START, runsRig, until, type RunsRig } from "./runs-rig.js";
import { createWs as createWsRaw, gitSkipReason } from "./worktrees-rig.js";

const skip = gitSkipReason();
const create = async (user: Client, name?: string): Promise<string> => (await createWsRaw(user, (_m, x) => (assert.equal(x.ok, true, JSON.stringify(x.error)), x), name)).id;

async function setup(t: TestContext, options: Parameters<typeof runsRig>[0] = {}): Promise<{ r: RunsRig; user: Client }> {
  const r = await runsRig(options);
  t.after(() => r.cleanup());
  return { r, user: await r.connect() };
}

/** Start a run in `id` and have it end (stopped, its leader gone), leaving its process group as the test sets it. */
async function finishedRunWithGroup(r: RunsRig, user: Client, id: string): Promise<{ runId: string; handle: ReturnType<typeof firstHandle> }> {
  const s = await user.call("axis.cli-runs", "start", START(id), newKey());
  assert.equal(s.ok, true, JSON.stringify(s.error));
  const runId = String((s.result?.["run"] as Record<string, unknown>)["runId"]);
  const handle = firstHandle(r, id);
  const stop = await user.call("axis.cli-runs", "stop", { runId }, newKey());
  assert.equal(stop.ok, true, JSON.stringify(stop.error));
  handle.exit(null, "SIGINT");
  await until(() => r.runs.service.get(runId).live === false && r.runs.service.get(runId).state === "CANCELLED");
  return { runId, handle };
}
const firstHandle = (r: RunsRig, _id: string) => r.pty.handles[r.pty.handles.length - 1] as NonNullable<RunsRig["pty"]["handles"][number]>;

test("a finished run whose process group is still alive keeps the workspace active: finalise and a new start are refused until it is gone", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const id = await create(user);
  const { handle } = await finishedRunWithGroup(r, user, id);
  assert.equal(handle.groupUp, true);
  assert.equal(r.runs.service.hasActiveRun(id), true, "the supervisor's own view is empty, the group is not");
  const fin = await user.call("axis.worktrees", "finalise", { id, outcome: "archived" }, newKey());
  assert.equal(fin.error?.code, "E_CONFLICT");
  assert.equal(fin.error?.details?.["reason"], "active_run");
  assert.equal(r.journal.getWorkspace(id)?.state, "READY", "nothing was changed");
  const again = await user.call("axis.cli-runs", "start", START(id), newKey());
  assert.equal(again.error?.code, "E_CONFLICT");
  assert.equal(again.error?.details?.["reason"], "active_run");
  assert.equal(r.pty.spawns.length, 1, "no second process while the first run's group is alive");

  handle.groupUp = false; // the last process of the group is gone
  assert.equal(r.runs.service.hasActiveRun(id), false);
  const done = await user.call("axis.worktrees", "finalise", { id, outcome: "archived" }, newKey());
  assert.equal(done.ok, true, JSON.stringify(done.error));
});

test("a handle that cannot say whether its group is gone counts as alive", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const id = await create(user);
  const { handle } = await finishedRunWithGroup(r, user, id);
  handle.groupUp = false;
  handle.groupThrows = true;
  assert.equal(r.runs.service.hasActiveRun(id), true);
  const fin = await user.call("axis.worktrees", "finalise", { id, outcome: "archived" }, newKey());
  assert.equal(fin.error?.details?.["reason"], "active_run");
  handle.groupThrows = false;
  assert.equal(r.runs.service.hasActiveRun(id), false);
});

test("a pty handle with no group probe is killed and the start fails: a process that cannot be shown gone is never supervised", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const id = await create(user);
  r.pty.noProbe = true;
  const s = await user.call("axis.cli-runs", "start", START(id), newKey());
  assert.equal(s.ok, false);
  assert.equal(s.error?.code, "E_UNAVAILABLE");
  assert.deepEqual(r.pty.noProbeKills, ["SIGKILL"]);
  assert.equal(r.runs.service.hasActiveRun(id), false);
});

test("groups under watch are bounded: a spawn beyond the cap is refused and nothing is spawned", { skip }, async (t) => {
  const r = await runsRig({});
  t.after(() => r.cleanup());
  // A second binding over the same pieces with a cap of one, to see the refusal without hundreds of workspaces.
  const { createRunsBinding } = await import("../src/index.js");
  const capped = createRunsBinding({ ...r.deps, maxTrackedGroups: 1 });
  t.after(() => capped.dispose());
  const user = await r.connect();
  const a = await create(user, "One");
  const b = await create(user, "Two");
  const mint = r.handlerDeps.minter;
  const agent = (r.answers.agents as unknown[])[0];
  const first = await capped.service.start({ workspaceId: a, agent, actor: "user", trust: mint.attest({ workspaceId: a, projectId: r.projectId }) });
  assert.equal(first.replayed, false);
  assert.equal(r.pty.spawns.length, 1);
  await assert.rejects(
    capped.service.start({ workspaceId: b, agent, actor: "user", trust: mint.attest({ workspaceId: b, projectId: r.projectId }) }),
    (e: { code?: string }) => e.code === "E_UNAVAILABLE",
  );
  assert.equal(r.pty.spawns.length, 1, "the second run was never spawned");
});

test("dispose kills every live process, leaves no timer behind, and a group still alive keeps counting as active", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const id = await create(user);
  const s = await user.call("axis.cli-runs", "start", START(id), newKey());
  assert.equal(s.ok, true, JSON.stringify(s.error));
  const handle = firstHandle(r, id);
  r.runs.dispose();
  assert.ok(handle.kills.includes("SIGKILL"));
  assert.equal(r.timers.size, 0, "every supervisor timer was cleared");
  assert.equal(r.runs.service.hasActiveRun(id), true, "the killed process may not be gone yet");
  handle.groupUp = false;
  assert.equal(r.runs.service.hasActiveRun(id), false);
});
