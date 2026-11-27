// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import * as path from "node:path";
import { worktreesMethods, type WorktreesMethod } from "@axis/protocol";
import { newKey, type Client, type Msg } from "./approvals-rig.js";
import { finaliseApproved, createWs as createWsRaw, gitSkipReason, worktreesRig, type Rig } from "./worktrees-rig.js";

const skip = gitSkipReason();
const WT = "axis.worktrees";
const createWs = (user: Client, name?: string, over?: Record<string, unknown>, key?: string) => createWsRaw(user, conforms, name, over, key);

async function setup(t: TestContext): Promise<{ r: Rig; user: Client }> {
  const r = await worktreesRig();
  t.after(() => r.cleanup());
  return { r, user: await r.connect() };
}

/** Every answer must match the contract's own response schema (the daemon checks too: this is the port conformance). */
function conforms(method: WorktreesMethod, m: Msg): Msg {
  assert.equal(m.ok, true, JSON.stringify(m.error));
  assert.equal(worktreesMethods[method].response.safeParse(m.result).success, true, `${method} response violates the contract`);
  return m;
}

test("create: a worktree on a branch of the base commit, journal READY, createdBy is the attested actor", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const { id, msg } = await createWs(user);
  const wt = (msg.result as { worktree: Record<string, unknown> }).worktree;
  assert.equal(wt["origin"], "axis");
  assert.equal(wt["state"], "READY");
  assert.equal(wt["projectId"], "proj-1");
  assert.equal(wt["baseSha"], r.git(r.repo, "rev-parse", "main").trim());
  assert.match(String(wt["branch"]), /^axis\/fix-the-parser-[0-9a-f]{6}$/);
  assert.equal(wt["present"], true);
  const ws = r.journal.getWorkspace(id);
  assert.equal(ws?.state, "READY");
  assert.equal(ws?.createdBy, "user");
  assert.equal(ws?.lockState, "unlocked");
  assert.equal(ws?.worktreePath, wt["path"]);
  assert.ok(path.dirname(realpathSync(String(ws?.worktreePath))).startsWith(r.root));
  assert.ok(existsSync(path.join(String(ws?.worktreePath), "a.txt")));
  // The journal saw CREATING first, then READY; the lock was taken and released; the audit has the change events.
  assert.deepEqual(r.journal.transitions("workspace", id).map((x) => x.to), ["CREATING", "READY"]);
  const actions = r.db.prepare("SELECT action FROM audit_events").all().map((x) => (x as { action: string }).action);
  for (const a of ["journal.workspace.lock", "journal.workspace.unlock", "journal.workspace.record", "worktree.create"]) assert.ok(actions.includes(a), a);
});

test("create: an agent actor cannot, and a payload cannot name the creator or a path", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const agent = await r.connect("agent:x#conn-2#win-1");
  const denied = await agent.call(WT, "create", { projectId: "proj-1", name: "n" }, newKey());
  assert.equal(denied.error?.code, "E_POLICY_DENIED");
  for (const extra of [{ createdBy: "agent:x" }, { path: "/tmp/x" }, { repoPath: r.repo }]) {
    const bad = await user.call(WT, "create", { projectId: "proj-1", name: "n", ...extra }, newKey());
    assert.equal(bad.error?.code, "E_INVALID_ARGUMENT");
  }
  assert.equal(r.journal.listWorkspaces({ includeRemoved: true }).length, 0);
});

test("create: replaying the same key and payload returns the stored result and creates nothing; a different payload is E_IDEMPOTENCY_CONFLICT", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const key = newKey();
  const first = conforms("create", await user.call(WT, "create", { projectId: "proj-1", name: "One" }, key));
  const again = conforms("create", await user.call(WT, "create", { projectId: "proj-1", name: "One" }, key));
  assert.deepEqual(again.result, first.result);
  assert.equal(r.journal.listWorkspaces().length, 1);
  assert.equal(r.git(r.repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 2);
  const other = await user.call(WT, "create", { projectId: "proj-1", name: "Two" }, key);
  assert.equal(other.error?.code, "E_IDEMPOTENCY_CONFLICT");
  assert.equal(r.journal.listWorkspaces().length, 1);
});

test("create: two workspaces with the same name get different branches; an unknown project or base ref is refused with fixed text", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const a = await createWs(user, "Same");
  const b = await createWs(user, "Same");
  assert.notEqual(r.journal.getWorkspace(a.id)?.branch, r.journal.getWorkspace(b.id)?.branch);
  const noProject = await user.call(WT, "create", { projectId: "nope", name: "n" }, newKey());
  assert.equal(noProject.error?.code, "E_NOT_FOUND");
  const noRef = await user.call(WT, "create", { projectId: "proj-1", name: "n", baseRef: "does-not-exist" }, newKey());
  assert.equal(noRef.error?.code, "E_NOT_FOUND");
  assert.equal(r.journal.listWorkspaces({ includeRemoved: true }).length, 2, "a refused base ref leaves no journal row");
});

test("list and status: the journal's workspaces with live facts, external worktrees without an id, unknown ids refused", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const { id } = await createWs(user);
  const ws = r.journal.getWorkspace(id);
  const outside = path.join(r.tmp, "external");
  r.git(r.repo, "worktree", "add", "-q", "-b", "ext", outside);
  writeFileSync(path.join(String(ws?.worktreePath), "new.txt"), "x");
  writeFileSync(path.join(String(ws?.worktreePath), "a.txt"), "changed\n");
  const list = conforms("list", await user.call(WT, "list", { projectId: "proj-1" }));
  const items = (list.result as { worktrees: Array<Record<string, unknown>> }).worktrees;
  const mine = items.find((i) => i["id"] === id);
  assert.deepEqual(mine?.["dirty"], { staged: 0, unstaged: 1, untracked: 1 });
  assert.equal(mine?.["ahead"], 0);
  const ext = items.find((i) => i["origin"] === "external");
  assert.ok(ext && ext["id"] === undefined && ext["state"] === undefined);
  assert.equal(items.filter((i) => i["origin"] === "axis").length, 1, "the main checkout is not listed");
  const st = conforms("status", await user.call(WT, "status", { ids: [id] }));
  assert.equal((st.result as { worktrees: unknown[] }).worktrees.length, 1);
  assert.equal((await user.call(WT, "status", { ids: [id, "ws-missing"] })).error?.code, "E_NOT_FOUND");
  assert.equal((await user.call(WT, "list", { projectId: "nope" })).error?.code, "E_NOT_FOUND");
});

test("finalise: archives, journal FINALISED with its outcome and audit; again is E_CONFLICT; dirty needs a confirmation it cannot get", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const { id } = await createWs(user);
  const ws = r.journal.getWorkspace(id);
  writeFileSync(path.join(String(ws?.worktreePath), "a.txt"), "dirty\n");
  // Tier 4: a dirty workspace is not finalised by the plain call; it is a challenge with a native dialog and changes nothing.
  const dirty = await user.call(WT, "finalise", { id, outcome: "archived" }, newKey());
  assert.equal(dirty.error?.code, "E_APPROVAL_REQUIRED");
  const pending = (dirty.error?.details as { challenge: { challengeId: string; digest: string; nativeConfirmationRequired: boolean } }).challenge;
  assert.equal(pending.nativeConfirmationRequired, true);
  assert.equal((await user.call("axis.approvals", "resolve", { challengeId: pending.challengeId, decision: "deny", digest: pending.digest })).ok, true);
  assert.equal(r.journal.getWorkspace(id)?.state, "READY", "a refused finalise changes nothing");
  assert.equal(r.journal.getWorkspace(id)?.lockState, "unlocked");
  r.git(String(ws?.worktreePath), "checkout", "--", "a.txt");
  const ok = conforms("finalise", await finaliseApproved(r, user, id, "archived"));
  assert.equal((ok.result as { archiveRef: string }).archiveRef, `refs/axis/archive/${id}`);
  const after = r.journal.getWorkspace(id);
  assert.equal(after?.state, "FINALISED");
  assert.equal(after?.finaliseOutcome, "archived");
  assert.ok(r.db.prepare("SELECT 1 FROM audit_events WHERE action = 'worktree.finalise'").get());
  assert.equal((await finaliseApproved(r, user, id, "archived")).error?.code, "E_CONFLICT");
  assert.equal(readFileSync(path.join(String(ws?.worktreePath), "a.txt"), "utf8"), "alpha\n");
});

test("finalise: refused while a run is active, and while the journal has an unfinished run", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const { id } = await createWs(user);
  r.active.add(id);
  const a = await finaliseApproved(r, user, id, "archived");
  assert.equal(a.error?.code, "E_CONFLICT");
  assert.deepEqual(a.error?.details, { reason: "active_run" });
  r.active.clear();
  const run = r.journal.createRun({ workspaceId: id, kind: "cli", createdBy: "user" }).value;
  assert.equal((await finaliseApproved(r, user, id, "archived")).error?.details?.["reason"], "active_run");
  r.journal.transitionRun(run.id, "CANCELLED", { actor: "user" });
  conforms("finalise", await finaliseApproved(r, user, id, "archived"));
});

test("restoreFromRunBase: restores a file from the run base, one backup, and only for a run of this workspace", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const { id } = await createWs(user);
  const other = await createWs(user, "Other");
  const ws = r.journal.getWorkspace(id);
  const run = r.journal.createRun({ workspaceId: id, kind: "cli", createdBy: "user" }).value;
  const foreign = r.journal.createRun({ workspaceId: other.id, kind: "cli", createdBy: "user" }).value;
  for (const x of [run, foreign]) {
    r.git(r.repo, "update-ref", `refs/axis/runbase/${x.id}`, r.git(r.repo, "rev-parse", `refs/axis/runbase/${x === run ? id : other.id}`).trim());
  }
  r.journal.transitionRun(run.id, "CANCELLED", { actor: "user" });
  writeFileSync(path.join(String(ws?.worktreePath), "a.txt"), "edited\n");
  const done = conforms("restoreFromRunBase", await user.call(WT, "restoreFromRunBase", { id, runId: run.id, paths: ["a.txt"] }, newKey()));
  assert.deepEqual((done.result as { restored: string[] }).restored, ["a.txt"]);
  assert.equal(readFileSync(path.join(String(ws?.worktreePath), "a.txt"), "utf8"), "alpha\n");
  const backup = (done.result as { backupRef: string }).backupRef;
  assert.ok(r.git(r.repo, "rev-parse", "--verify", backup).trim().length >= 40);
  const wrong = await user.call(WT, "restoreFromRunBase", { id, runId: foreign.id, paths: ["a.txt"] }, newKey());
  assert.equal(wrong.error?.code, "E_NOT_FOUND");
  const missing = await user.call(WT, "restoreFromRunBase", { id, runId: run.id, paths: ["nope.txt"] }, newKey());
  assert.equal(missing.error?.code, "E_NOT_FOUND");
  for (const bad of ["../x", "/etc/passwd", ".git/config", "a/../b"]) {
    assert.equal((await user.call(WT, "restoreFromRunBase", { id, runId: run.id, paths: [bad] }, newKey())).error?.code, "E_INVALID_ARGUMENT", bad);
  }
});
