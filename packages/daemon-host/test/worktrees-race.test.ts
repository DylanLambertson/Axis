// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { test, type TestContext } from "node:test";
import * as path from "node:path";
import { newKey, type Client } from "./approvals-rig.js";
import { createWs as createWsRaw, gitSkipReason, worktreesRig, type Rig } from "./worktrees-rig.js";

const skip = gitSkipReason();
const createWs = (user: Client, name?: string) => createWsRaw(user, (_m, x) => (assert.equal(x.ok, true, JSON.stringify(x.error)), x), name);
const svc = { caller: { actor: "user", connectionId: "c", windowId: "w" }, signal: new AbortController().signal };
const live = new AbortController().signal;
const dirOf = (r: Rig, id: string): string => String(r.journal.getWorkspace(id)?.worktreePath);

/**
 * A repair (`finalise` on an interrupted finalise) that completes while a SECOND reconcile is running: the reconcile is held
 * at its second project's `list`, after it already looked at the first project.
 */
async function repairDuringReconcile(t: TestContext, tamper: boolean) {
  const hold = { on: false, reached: () => undefined as void, gate: Promise.resolve() as Promise<void> };
  const state = { fail: true };
  const r: Rig = await worktreesRig({
    failAudit: (e) => state.fail && e.action === "worktree.finalise" && (e.payload as { phase?: string }).phase === "done",
    testSeams: {
      wrapManager: (m) => ({
        ...m,
        list: async (p) => {
          if (hold.on && p !== r.repo) {
            hold.reached();
            await hold.gate;
          }
          return m.list(p);
        },
      }),
    },
  });
  t.after(() => r.cleanup());
  const user = await r.connect();
  const { id } = await createWs(user);
  assert.equal((await user.call("axis.worktrees", "finalise", { id, outcome: "archived" }, newKey())).ok, false);
  state.fail = false;
  const second = path.join(r.tmp, "repo2");
  mkdirSync(second);
  r.git(second, "init", "-q");
  r.git(second, "symbolic-ref", "HEAD", "refs/heads/main");
  r.git(second, "commit", "-q", "--allow-empty", "-m", "init");
  r.journal.registerProject({ id: "proj-2", path: second, displayName: "two", trusted: true, actor: "user" });
  assert.deepEqual((await r.binding.service.reconcile(live)).needsAttention, [{ workspaceId: id, reason: "finalise_incomplete" }]);
  if (tamper) r.db.exec(`UPDATE agent_workspaces SET base_sha = '${"1".repeat(40)}' WHERE id = '${id}'`);
  const reached = new Promise<void>((res) => (hold.reached = res));
  let release!: () => void;
  hold.gate = new Promise<void>((res) => (release = res));
  hold.on = true;
  const running = r.binding.service.reconcile(live);
  await reached;
  // The repair completes while the reconcile is in flight.
  assert.equal((await r.binding.service.finalise({ id, outcome: "archived" }, svc)).state, "FINALISED");
  hold.on = false;
  release();
  await running;
  return { r, id };
}

test("a repair during a reconcile: the stale finalise_incomplete entry does not come back", { skip }, async (t) => {
  const { r, id } = await repairDuringReconcile(t, false);
  assert.equal(r.binding.needsAttention(id, "remove"), false);
  assert.equal(r.binding.needsAttention(id, "finalise"), false);
});

test("a repair during a reconcile keeps every FRESH finding for that workspace (a real ref_mismatch is not cleared)", { skip }, async (t) => {
  const { r, id } = await repairDuringReconcile(t, true);
  assert.equal(r.binding.needsAttention(id, "remove"), true, "the ref_mismatch this pass found is still flagged");
});

test("a reconcile cut at the report cap makes the SERVICE fail closed for every workspace", { skip }, async (t) => {
  const r = await worktreesRig({ testSeams: { maxReports: 1 } });
  t.after(() => r.cleanup());
  const user = await r.connect();
  const a = (await createWs(user, "One")).id;
  const b = (await createWs(user, "Two")).id;
  rmSync(dirOf(r, a), { recursive: true, force: true });
  rmSync(dirOf(r, b), { recursive: true, force: true });
  const report = await r.binding.service.reconcile(live);
  assert.equal(report.incomplete, true);
  assert.equal(r.binding.needsAttention("some-other-workspace", "remove"), true);
  assert.equal(r.binding.needsAttention("some-other-workspace", "finalise"), true);
});
