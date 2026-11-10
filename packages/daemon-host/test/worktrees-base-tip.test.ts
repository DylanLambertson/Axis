// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DaemonError } from "@axis/daemon";
import { finaliseApproved, createWs as createWsRaw, gitSkipReason, worktreesRig, type Rig, type RigOptions } from "./worktrees-rig.js";

/** FU-WT-BASE2: the journal records the base branch's tip at create, and `merged` needs the base to still descend from it. */
const skip = gitSkipReason();
const createWs = (user: Parameters<typeof createWsRaw>[0], name?: string, over: Record<string, unknown> = {}) =>
  createWsRaw(user, (_m, x) => (assert.equal(x.ok, true, JSON.stringify(x.error)), x), name, over);
const dirOf = (r: Rig, id: string): string => String(r.journal.getWorkspace(id)?.worktreePath);
const svc = { caller: { actor: "user", connectionId: "c", windowId: "w" }, signal: new AbortController().signal };
const isReason = (reason: string) => (e: unknown) => e instanceof DaemonError && e.details?.["reason"] === reason;
const finaliseDone = (e: { action: string; payload?: unknown }) => e.action === "worktree.finalise" && (e.payload as { phase?: string }).phase === "done";

async function rig(t: TestContext, over: RigOptions = {}) {
  const r = await worktreesRig(over);
  t.after(() => r.cleanup());
  return { r, user: await r.connect() };
}

/** The run commits, then moves its own branch onto history without the base tip and points `main` at it. */
function rewriteOffTip(r: Rig, id: string): void {
  const dir = dirOf(r, id);
  r.git(dir, "commit", "-q", "--allow-empty", "-m", "work");
  const root = r.git(dir, "commit-tree", "HEAD^{tree}", "-m", "unrelated root").trim();
  r.git(dir, "reset", "-q", "--hard", root);
  r.git(r.repo, "update-ref", "refs/heads/main", root);
}

test("create records the base branch's tip with it: the commit the workspace was made from", { skip }, async (t) => {
  const { r, user } = await rig(t);
  const { id } = await createWs(user);
  const ws = r.journal.getWorkspace(id);
  assert.equal(ws?.baseTip, r.git(r.repo, "rev-parse", "refs/heads/main").trim());
  assert.equal(ws?.baseTip, ws?.baseSha);
  const pinned = await createWs(user, "pinned to a commit", { baseRef: ws?.baseSha });
  assert.equal(r.journal.getWorkspace(pinned.id)?.baseTip, null);
});

test("merged: a base that no longer descends from the recorded tip is refused (finalise and repair)", { skip }, async (t) => {
  const state = { fail: false };
  const { r, user } = await rig(t, { failAudit: (e) => state.fail && finaliseDone(e) });
  const { id } = await createWs(user);
  rewriteOffTip(r, id);
  // Without the tip, git alone would call this merged: the base holds the workspace head.
  r.git(r.repo, "merge-base", "--is-ancestor", r.git(dirOf(r, id), "rev-parse", "HEAD").trim(), "refs/heads/main");
  const res = await finaliseApproved(r, user, id, "merged");
  assert.equal(res.error?.code, "E_CONFLICT");
  assert.deepEqual(res.error?.details, { reason: "base_rewritten" });
  assert.equal(r.journal.getWorkspace(id)?.state, "READY");
  state.fail = true;
  assert.equal((await finaliseApproved(r, user, id, "abandoned")).ok, false);
  state.fail = false;
  await r.binding.service.reconcile(new AbortController().signal);
  await assert.rejects(r.binding.service.finalise({ id, outcome: "merged" }, svc), isReason("not_merged"));
  assert.equal(r.journal.getWorkspace(id)?.state, "READY");
  assert.equal((await r.binding.service.finalise({ id, outcome: "abandoned" }, svc)).state, "FINALISED");
});

test("merged: a base deleted after create is refused", { skip }, async (t) => {
  const { r, user } = await rig(t);
  const { id } = await createWs(user);
  r.git(r.repo, "checkout", "-q", "--detach");
  r.git(r.repo, "update-ref", "-d", "refs/heads/main");
  assert.deepEqual((await finaliseApproved(r, user, id, "merged")).error?.details, { reason: "no_base_branch" });
});

test("merged fails closed for a workspace whose base branch was recorded before the tip was (a version 5 row)", { skip }, async (t) => {
  const state = { fail: false };
  const { r, user } = await rig(t, { failAudit: (e) => state.fail && finaliseDone(e) });
  const { id } = await createWs(user);
  // Simulate the older row: the set-once trigger is what normally forbids clearing the tip.
  r.db.exec("DROP TRIGGER agent_workspaces_base_tip_once");
  r.db.prepare("UPDATE agent_workspaces SET base_tip = NULL WHERE id = ?").run(id);
  assert.equal(r.journal.getWorkspace(id)?.baseBranch, "refs/heads/main");
  assert.equal(r.journal.getWorkspace(id)?.baseTip, null);
  // The workspace head IS in main (nothing was committed), so only the missing tip can refuse it.
  assert.deepEqual((await finaliseApproved(r, user, id, "merged")).error?.details, { reason: "no_base_branch" });
  state.fail = true;
  assert.equal((await finaliseApproved(r, user, id, "abandoned")).ok, false);
  state.fail = false;
  await r.binding.service.reconcile(new AbortController().signal);
  await assert.rejects(r.binding.service.finalise({ id, outcome: "merged" }, svc), isReason("not_merged"));
});

test("merged: a real fast-forward after create is still merged on the repair path", { skip }, async (t) => {
  const state = { fail: false };
  const { r, user } = await rig(t, { failAudit: (e) => state.fail && finaliseDone(e) });
  const { id } = await createWs(user);
  r.git(dirOf(r, id), "commit", "-q", "--allow-empty", "-m", "work");
  r.git(r.repo, "merge", "-q", "--ff-only", r.git(dirOf(r, id), "rev-parse", "HEAD").trim());
  state.fail = true;
  assert.equal((await finaliseApproved(r, user, id, "merged")).ok, false);
  state.fail = false;
  await r.binding.service.reconcile(new AbortController().signal);
  assert.equal((await r.binding.service.finalise({ id, outcome: "merged" }, svc)).state, "FINALISED");
  assert.equal(r.journal.getWorkspace(id)?.finaliseOutcome, "merged");
});

test("merged is judged against the journal's tip, not the base sha (finalise and repair)", { skip }, async (t) => {
  const state = { fail: false };
  const { r, user } = await rig(t, { failAudit: (e) => state.fail && finaliseDone(e) });
  const { id } = await createWs(user);
  // A journal tip that main does not descend from, while the base sha and the head are in main: only the tip can refuse.
  const elsewhere = r.git(r.repo, "commit-tree", "HEAD^{tree}", "-m", "not in main").trim();
  r.db.exec("DROP TRIGGER agent_workspaces_base_tip_once");
  r.db.prepare("UPDATE agent_workspaces SET base_tip = ? WHERE id = ?").run(elsewhere, id);
  assert.deepEqual((await finaliseApproved(r, user, id, "merged")).error?.details, { reason: "base_rewritten" });
  state.fail = true;
  assert.equal((await finaliseApproved(r, user, id, "abandoned")).ok, false);
  state.fail = false;
  await r.binding.service.reconcile(new AbortController().signal);
  await assert.rejects(r.binding.service.finalise({ id, outcome: "merged" }, svc), isReason("not_merged"));
});
