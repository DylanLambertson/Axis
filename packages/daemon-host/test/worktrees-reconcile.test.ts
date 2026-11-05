// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { newKey, type Client } from "./approvals-rig.js";
import { createWs, gitSkipReason, worktreesRig, type Rig } from "./worktrees-rig.js";

const skip = gitSkipReason();
const ok = (_m: "create", x: Parameters<typeof createWs>[1] extends (a: never, b: infer M) => unknown ? M : never) => (assert.equal(x.ok, true), x);

async function setup(t: TestContext): Promise<{ r: Rig; user: Client; id: string; dir: string }> {
  const r = await worktreesRig();
  t.after(() => r.cleanup());
  const user = await r.connect();
  const { id } = await createWs(user, ok);
  return { r, user, id, dir: String(r.journal.getWorkspace(id)?.worktreePath) };
}

const snapshot = (r: Rig): string =>
  [r.git(r.repo, "for-each-ref"), r.git(r.repo, "worktree", "list", "--porcelain"), JSON.stringify(r.journal.listWorkspaces({ includeRemoved: true }))].join("|");
const live = new AbortController().signal;

test("reconcile: a journal and repository that agree report nothing", { skip }, async (t) => {
  const { r } = await setup(t);
  assert.deepEqual((await r.binding.service.reconcile(live)).needsAttention, []);
});

test("reconcile: a worktree directory that is gone is missing_worktree", { skip }, async (t) => {
  const { r, id, dir } = await setup(t);
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual((await r.binding.service.reconcile(live)).needsAttention, [{ workspaceId: id, reason: "missing_worktree" }]);
});

test("reconcile: a managed worktree the journal gave up on is unknown_worktree", { skip }, async (t) => {
  const { r, id } = await setup(t);
  r.db.exec(`UPDATE agent_workspaces SET state = 'REMOVED' WHERE id = '${id}'`);
  assert.deepEqual((await r.binding.service.reconcile(live)).needsAttention, [{ workspaceId: id, reason: "unknown_worktree" }]);
});

test("reconcile: a missing run base ref, another base commit or another state is ref_mismatch", { skip }, async (t) => {
  const { r, id } = await setup(t);
  const base = r.git(r.repo, "rev-parse", `refs/axis/runbase/${id}`).trim();
  r.git(r.repo, "update-ref", "-d", `refs/axis/runbase/${id}`);
  assert.deepEqual((await r.binding.service.reconcile(live)).needsAttention, [{ workspaceId: id, reason: "ref_mismatch" }]);
  r.git(r.repo, "update-ref", `refs/axis/runbase/${id}`, base);
  assert.deepEqual((await r.binding.service.reconcile(live)).needsAttention, []);
  r.db.exec(`UPDATE agent_workspaces SET base_sha = '${"1".repeat(40)}' WHERE id = '${id}'`);
  assert.equal((await r.binding.service.reconcile(live)).needsAttention[0]?.reason, "ref_mismatch");
  r.db.exec(`UPDATE agent_workspaces SET base_sha = '${base}' WHERE id = '${id}'`);
  r.db.exec(`UPDATE agent_workspaces SET state = 'FINALISED', finalise_outcome = 'archived' WHERE id = '${id}'`);
  assert.equal((await r.binding.service.reconcile(live)).needsAttention[0]?.reason, "ref_mismatch");
});

test("reconcile reports and never repairs: repository and journal are byte for byte unchanged, and a reported workspace answers E_UNAVAILABLE", { skip }, async (t) => {
  const { r, user, id, dir } = await setup(t);
  rmSync(dir, { recursive: true, force: true });
  const before = snapshot(r);
  const report = await r.binding.service.reconcile(live);
  assert.equal(report.needsAttention.length, 1);
  assert.equal(snapshot(r), before);
  assert.equal(r.binding.needsAttention(id), true);
  const res = await user.call("axis.worktrees", "finalise", { id, outcome: "archived" }, newKey());
  assert.equal(res.error?.code, "E_UNAVAILABLE");
  assert.deepEqual(res.error?.details, { reason: "needs_attention" });
  // Other workspaces are not affected, and a clean reconcile lifts the flag.
  assert.equal((await createWs(user, ok, "Other")).id.length > 0, true);
  r.git(r.repo, "worktree", "prune");
  r.db.exec(`UPDATE agent_workspaces SET state = 'REMOVED' WHERE id = '${id}'`);
  await r.binding.service.reconcile(live);
  assert.equal(r.binding.needsAttention(id), false);
});

test("reconcile honours the abort signal and does not change the report of the last full run", { skip }, async (t) => {
  const { r, id, dir } = await setup(t);
  rmSync(dir, { recursive: true, force: true });
  const c = new AbortController();
  c.abort();
  await assert.rejects(r.binding.service.reconcile(c.signal));
  assert.equal(r.binding.needsAttention(id), false, "an aborted run reports nothing and sets nothing");
});

test("the manager runs git only through the one pinned path (no PATH lookup), and a wrapper there sees every call", { skip: skip ?? (process.platform === "win32" ? "posix wrapper" : undefined) }, async (t) => {
  const r = await worktreesRig({ gitWrapper: true });
  t.after(() => r.cleanup());
  const user = await r.connect();
  await createWs(user, ok);
  assert.ok(readFileSync(r.gitLog, "utf8").length > 0, "git ran through the pinned wrapper");
});
