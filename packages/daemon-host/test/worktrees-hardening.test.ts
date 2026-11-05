// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import * as path from "node:path";
import { DaemonError } from "@axis/daemon";
import { newKey, type Client, type Msg } from "./approvals-rig.js";
import { createWs as createWsRaw, finishedRun, gitSkipReason, worktreesRig, type Rig, type RigOptions } from "./worktrees-rig.js";
import { worktreesMethods } from "@axis/protocol";

const skip = gitSkipReason();
const WT = "axis.worktrees";
const createWs = (user: Client, name?: string) => createWsRaw(user, (_m, x) => (assert.equal(x.ok, true, JSON.stringify(x.error)), x), name);

async function setup(t: TestContext, options: RigOptions = {}): Promise<{ r: Rig; user: Client }> {
  const r = await worktreesRig(options);
  t.after(() => r.cleanup());
  return { r, user: await r.connect() };
}
const dirOf = (r: Rig, id: string): string => String(r.journal.getWorkspace(id)?.worktreePath);
const ctx = (r: Rig) => ({ identity: { connectionId: "c", windowId: "win-1", actorId: "a", actor: "user", trusted: true, clientKind: "desktop" }, requestId: "q", correlationId: "c", signal: new AbortController().signal, r });
const hookError = async (r: Rig, method: "remove" | "finalise", id: string): Promise<DaemonError> => {
  try {
    const lock = await (r.binding.content[method] as unknown as (c: unknown, p: unknown) => Promise<{ withLock<T>(f: (d: string) => Promise<T>): Promise<T> }>)(ctx(r), { id });
    await lock.withLock(async () => "ran");
  } catch (e) {
    assert.ok(e instanceof DaemonError, String(e));
    return e;
  }
  assert.fail("the hook should have refused");
};

// ---- B1: restoreFromRunBase must not write into another workspace, outside, or into .git ----

async function twoWorkspaces(t: TestContext) {
  const { r, user } = await setup(t);
  const a = (await createWs(user, "Alpha")).id;
  const b = (await createWs(user, "Bravo")).id;
  writeFileSync(path.join(dirOf(r, b), "a.txt"), "B unsaved work\n");
  const runId = finishedRun(r, a);
  const restore = (paths: string[]): Promise<Msg> => user.call(WT, "restoreFromRunBase", { id: a, runId, paths }, newKey());
  return { r, user, a, b, runId, restore };
}
const untouched = (r: Rig, b: string): void => {
  assert.equal(readFileSync(path.join(dirOf(r, b), "a.txt"), "utf8"), "B unsaved work\n", "B's unsaved work is intact");
  assert.equal(r.git(r.repo, "for-each-ref", `refs/axis/backup/${b}`), "", "no backup ref was written in B's name");
  const rows = r.db.prepare("SELECT target FROM audit_events WHERE action = 'worktree.restore'").all() as Array<{ target: string }>;
  assert.deepEqual(rows, [], "no restore audit event");
  assert.equal(r.journal.getWorkspace(b)?.lockState, "unlocked");
};

test("B1: a symlink in A that leads to B is refused; B's file, refs and audit are untouched", { skip: skip ?? (process.platform === "win32" ? "symlinks" : undefined) }, async (t) => {
  const { r, a, b, restore } = await twoWorkspaces(t);
  symlinkSync(dirOf(r, b), path.join(dirOf(r, a), "link"));
  const res = await restore(["link/a.txt"]);
  assert.equal(res.error?.code, "E_INVALID_ARGUMENT");
  assert.deepEqual(res.error?.details, { reason: "unsafe_path" });
  untouched(r, b);
});

test("B1: symlinks to the outside, to the .git directory, and dangling ones are refused", { skip: skip ?? (process.platform === "win32" ? "symlinks" : undefined) }, async (t) => {
  const { r, a, b, restore } = await twoWorkspaces(t);
  const outside = path.join(r.tmp, "outside");
  mkdirSync(outside);
  const wa = dirOf(r, a);
  symlinkSync(outside, path.join(wa, "out"));
  symlinkSync(path.join(r.repo, ".git"), path.join(wa, "gitlink"));
  symlinkSync(path.join(r.tmp, "does-not-exist"), path.join(wa, "dangling"));
  symlinkSync(path.join(r.tmp, "does-not-exist"), path.join(wa, "leaf.txt"));
  for (const p of ["out/a.txt", "gitlink/config", "dangling/a.txt", "leaf.txt"]) {
    const res = await restore([p]);
    assert.equal(res.error?.code, "E_INVALID_ARGUMENT", p);
  }
  assert.equal(existsSync(path.join(outside, "a.txt")), false);
  assert.equal(r.git(r.repo, "for-each-ref", "refs/axis/backup"), "");
  untouched(r, b);
});

test("B1: the manager refuses a write that resolves into another worktree even when the host's pre-check passed", { skip: skip ?? (process.platform === "win32" ? "symlinks" : undefined) }, async (t) => {
  const { r, a, b, runId } = await twoWorkspaces(t);
  const wa = dirOf(r, a);
  // The link appears after the host's check (a swap in the window): the manager's expectedWorktree check is the backstop.
  const real = r.binding.service.restoreFromRunBase.bind(r.binding.service);
  symlinkSync(dirOf(r, b), path.join(wa, "late"));
  await assert.rejects(
    real({ id: a, runId, paths: ["late/a.txt"] }, { caller: { actor: "user", connectionId: "c", windowId: "w" }, signal: new AbortController().signal }),
  );
  untouched(r, b);
  // A normal restore still works.
  writeFileSync(path.join(wa, "a.txt"), "edited\n");
  const ok = await real({ id: a, runId, paths: ["a.txt"] }, { caller: { actor: "user", connectionId: "c", windowId: "w" }, signal: new AbortController().signal });
  assert.equal(worktreesMethods.restoreFromRunBase.response.safeParse(ok).success, true);
  assert.equal(readFileSync(path.join(wa, "a.txt"), "utf8"), "alpha\n");
});

// ---- S2: finalise is journal first ----

test("finalise: an audit failure before git leaves git untouched; a git failure leaves the journal READY and a retry works", { skip }, async (t) => {
  let fail = true;
  const { r, user } = await setup(t, { failAudit: (e) => fail && e.action === "worktree.finalise" });
  const { id } = await createWs(user);
  const bad = await user.call(WT, "finalise", { id, outcome: "archived" }, newKey());
  assert.equal(bad.ok, false);
  assert.equal(r.git(r.repo, "for-each-ref", "refs/axis/archive"), "", "git was not touched");
  assert.equal(r.journal.getWorkspace(id)?.state, "READY");
  assert.equal(r.journal.getWorkspace(id)?.lockState, "unlocked");
  fail = false;
  // git failure: a commit that is not in the base branch, so "merged" is refused by the manager; the journal stays READY.
  r.git(dirOf(r, id), "commit", "-q", "--allow-empty", "-m", "work");
  const notMerged = await user.call(WT, "finalise", { id, outcome: "merged" }, newKey());
  assert.equal(notMerged.error?.code, "E_CONFLICT");
  assert.equal(r.journal.getWorkspace(id)?.state, "READY");
  assert.equal((await user.call(WT, "finalise", { id, outcome: "archived" }, newKey())).ok, true);
  assert.equal(r.journal.getWorkspace(id)?.state, "FINALISED");
});

test("finalise: git done but the journal write failed is recoverable: reconcile reports it and a retry completes the journal without git", { skip }, async (t) => {
  let fail = true;
  const { r, user } = await setup(t, { failAudit: (e) => fail && e.action === "worktree.finalise" && (e.payload as { phase?: string }).phase === "done" });
  const { id } = await createWs(user);
  const bad = await user.call(WT, "finalise", { id, outcome: "archived" }, newKey());
  assert.equal(bad.ok, false);
  assert.equal(r.journal.getWorkspace(id)?.state, "READY", "the transaction rolled back");
  assert.ok(r.git(r.repo, "for-each-ref", "refs/axis/archive").includes(id), "git did finalise");
  const report = await r.binding.service.reconcile(new AbortController().signal);
  assert.deepEqual(report.needsAttention, [{ workspaceId: id, reason: "ref_mismatch" }]);
  fail = false;
  // Flagged workspaces answer E_UNAVAILABLE until a clean reconcile; the retry path is exercised through the service.
  const done = await r.binding.service.finalise({ id, outcome: "archived" }, { caller: { actor: "user", connectionId: "c", windowId: "w" }, signal: new AbortController().signal });
  assert.equal(done.archiveRef, `refs/axis/archive/${id}`);
  assert.equal(r.journal.getWorkspace(id)?.state, "FINALISED");
  assert.deepEqual((await r.binding.service.reconcile(new AbortController().signal)).needsAttention, []);
});

// ---- S3: no dialog for a call that will be refused ----

test("content hooks refuse before any challenge: wrong state, needs attention, active run and git drift, with their closed codes", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const { id } = await createWs(user);
  const e1 = await hookError(r, "remove", id);
  assert.deepEqual([e1.code, e1.details], ["E_CONFLICT", { reason: "not_finalised" }]);
  assert.equal(await hookError(r, "remove", "ws-nope").then((e) => e.code), "E_NOT_FOUND");
  assert.equal((await user.call(WT, "finalise", { id, outcome: "archived" }, newKey())).ok, true);
  const e2 = await hookError(r, "finalise", id);
  assert.deepEqual([e2.code, e2.details], ["E_CONFLICT", { reason: "already_finalised" }]);
  r.active.add(id);
  assert.deepEqual((await hookError(r, "remove", id)).details, { reason: "active_run" });
  r.active.clear();
  // Git configuration that can run commands changed since the baseline.
  r.git(r.repo, "config", "core.hooksPath", path.join(r.tmp, "hooks"));
  const e3 = await hookError(r, "remove", id);
  assert.deepEqual([e3.code, e3.details], ["E_CONFLICT", { reason: "git_drift" }]);
  r.git(r.repo, "config", "--unset", "core.hooksPath");
  // A workspace the last reconcile reported: E_UNAVAILABLE, no dialog.
  r.db.exec(`UPDATE agent_workspaces SET base_sha = '${"1".repeat(40)}' WHERE id = '${id}'`);
  await r.binding.service.reconcile(new AbortController().signal);
  const e4 = await hookError(r, "remove", id);
  assert.deepEqual([e4.code, e4.details], ["E_UNAVAILABLE", { reason: "needs_attention" }]);
  assert.equal((await user.call(WT, "remove", { id }, newKey())).ok, false);
  assert.equal(r.nativeConfirms().length, 0);
});

// ---- S4: paths the earlier tests could not reach ----

const svcCtx = { caller: { actor: "user", connectionId: "c", windowId: "w" }, signal: new AbortController().signal };

test("service.remove: an active run seen by the service stops it before REMOVING; one seen only by the manager returns the row to FINALISED", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const { id } = await createWs(user);
  assert.equal((await user.call(WT, "finalise", { id, outcome: "archived" }, newKey())).ok, true);
  // The service's own check (the hook is bypassed by calling the service directly; a clean workspace needs no token).
  r.script.push(true);
  await assert.rejects(r.binding.service.remove({ id }, svcCtx), (e: unknown) => e instanceof DaemonError && e.details?.["reason"] === "active_run");
  assert.deepEqual(r.journal.transitions("workspace", id).map((x) => x.to), ["CREATING", "READY", "FINALISED"], "no REMOVING write was made");
  // Only the manager's refuseIfActiveRun sees the run (the service check and the lock record come first).
  r.script.push(false, true);
  await assert.rejects(r.binding.service.remove({ id }, svcCtx), (e: unknown) => e instanceof DaemonError && e.details?.["reason"] === "active_run");
  const t2 = r.journal.transitions("workspace", id);
  assert.deepEqual(t2.slice(-2).map((x) => [x.to, x.reason]), [["REMOVING", "REMOVE_REQUESTED"], ["FINALISED", "REMOVE_REFUSED"]]);
  assert.equal(r.journal.getWorkspace(id)?.lockState, "unlocked");
  assert.equal(existsSync(dirOf(r, id)), true);
  // And with no run it succeeds.
  const done = await r.binding.service.remove({ id }, svcCtx);
  assert.equal(done.state, "CLEANED");
});

test("locator: a recorded path replaced by a symlink to ANOTHER live worktree is refused by the realpath comparison", { skip: skip ?? (process.platform === "win32" ? "symlinks" : undefined) }, async (t) => {
  const { r, user } = await setup(t);
  const a = (await createWs(user, "Alpha")).id;
  const b = (await createWs(user, "Bravo")).id;
  const da = dirOf(r, a);
  rmSync(da, { recursive: true, force: true });
  symlinkSync(dirOf(r, b), da); // a real linked worktree: every other check would accept it
  await assert.rejects(r.binding.locator.locate(a), (e: unknown) => e instanceof DaemonError && e.code === "E_NOT_FOUND");
  assert.equal((await r.binding.locator.locate(b)).workTree, dirOf(r, b));
});
