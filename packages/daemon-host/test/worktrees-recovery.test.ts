// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import * as path from "node:path";
import { DaemonError } from "@axis/daemon";
import { newKey, type Client } from "./approvals-rig.js";
import { createWs as createWsRaw, gitSkipReason, worktreesRig, type Rig, type RigOptions } from "./worktrees-rig.js";

const skip = gitSkipReason();
const WT = "axis.worktrees";
const createWs = (user: Client, name?: string) => createWsRaw(user, (_m, x) => (assert.equal(x.ok, true, JSON.stringify(x.error)), x), name);
const dirOf = (r: Rig, id: string): string => String(r.journal.getWorkspace(id)?.worktreePath);
const svc = { caller: { actor: "user", connectionId: "c", windowId: "w" }, signal: new AbortController().signal };
const live = new AbortController().signal;

/** A workspace whose git finalise succeeded and whose journal step failed: the state a crash between them leaves. */
async function interrupted(t: TestContext, outcome: "merged" | "archived" | "abandoned" = "archived", over: RigOptions = {}) {
  const state = { fail: true };
  const r = await worktreesRig({ failAudit: (e) => state.fail && e.action === "worktree.finalise" && (e.payload as { phase?: string }).phase === "done", ...over });
  t.after(() => r.cleanup());
  const user = await r.connect();
  const { id } = await createWs(user);
  assert.equal((await user.call(WT, "finalise", { id, outcome }, newKey())).ok, false);
  state.fail = false;
  return { r, user, id };
}
const rows = (r: Rig, action: string): Array<{ outcome: string; payload: string }> =>
  r.db.prepare("SELECT outcome, payload FROM audit_events WHERE action = ? ORDER BY seq").all(action) as Array<{ outcome: string; payload: string }>;
const metaFile = (r: Rig, id: string): string => {
  const dir = path.join(r.repo, ".git", "worktrees");
  const name = readdirSync(dir).find((n) => readFileSync(path.join(dir, n, "axis-workspace.json"), "utf8").includes(id)) as string;
  return path.join(dir, name, "axis-workspace.json");
};

test("recovery: merged is recorded when git finds the commit in the base branch", { skip }, async (t) => {
  const { r, id } = await interrupted(t, "abandoned");
  await r.binding.service.reconcile(live);
  // The branch has the base commit only (an ancestor of main): git verifies it, so merged is accepted ...
  const ok = await r.binding.service.finalise({ id, outcome: "merged" }, svc);
  assert.equal(ok.state, "FINALISED");
  assert.equal(r.journal.getWorkspace(id)?.finaliseOutcome, "merged");
});

test("recovery: a commit that is not in the base is refused as merged, the journal stays READY and the row is flagged", { skip }, async (t) => {
  const state = { fail: false };
  const r = await worktreesRig({ failAudit: (e) => state.fail && e.action === "worktree.finalise" && (e.payload as { phase?: string }).phase === "done" });
  t.after(() => r.cleanup());
  const user = await r.connect();
  const { id } = await createWs(user);
  r.git(dirOf(r, id), "commit", "-q", "--allow-empty", "-m", "work not in main");
  state.fail = true;
  assert.equal((await user.call(WT, "finalise", { id, outcome: "abandoned" }, newKey())).ok, false);
  state.fail = false;
  await r.binding.service.reconcile(live);
  const res = await user.call(WT, "finalise", { id, outcome: "merged" }, newKey());
  assert.equal(res.error?.code, "E_CONFLICT");
  assert.deepEqual(res.error?.details, { reason: "not_merged" });
  assert.equal(r.journal.getWorkspace(id)?.state, "READY");
  assert.equal(r.binding.needsAttention(id), true);
  // The honest outcome (no merge claimed) completes it, and it is what the journal records.
  assert.equal((await user.call(WT, "finalise", { id, outcome: "abandoned" }, newKey())).ok, true);
  assert.equal(r.journal.getWorkspace(id)?.finaliseOutcome, "abandoned");
});

test("recovery does not trust the manager record alone: no archive ref, another commit, another id and a dirty tree are each refused", { skip }, async (t) => {
  const { r, id } = await interrupted(t);
  const refused = async (reason: string): Promise<void> => {
    await assert.rejects(r.binding.service.finalise({ id, outcome: "archived" }, svc), (e: unknown) => e instanceof DaemonError && e.details?.["reason"] === reason, reason);
    assert.equal(r.journal.getWorkspace(id)?.state, "READY");
  };
  const archive = r.git(r.repo, "rev-parse", `refs/axis/archive/${id}`).trim();
  r.git(r.repo, "update-ref", "-d", `refs/axis/archive/${id}`);
  await refused("no_archive");
  r.git(dirOf(r, id), "commit", "-q", "--allow-empty", "-m", "later work");
  r.git(r.repo, "update-ref", `refs/axis/archive/${id}`, archive);
  await refused("unverified"); // the archive ref is not the worktree's HEAD
  r.git(r.repo, "update-ref", `refs/axis/archive/${id}`, r.git(dirOf(r, id), "rev-parse", "HEAD").trim());
  writeFileSync(path.join(dirOf(r, id), "a.txt"), "unsaved\n");
  await refused("dirty");
  r.git(dirOf(r, id), "checkout", "--", "a.txt");
  const file = metaFile(r, id);
  const meta = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...meta, id: "ws-other" }));
  await refused("path_changed");
  writeFileSync(file, JSON.stringify(meta));
  const ok = await r.binding.service.finalise({ id, outcome: "archived" }, svc);
  assert.equal(ok.state, "FINALISED");
});

test("audit: a refused finalise leaves an intent row and a denied result row, never a success result", { skip }, async (t) => {
  const r = await worktreesRig();
  t.after(() => r.cleanup());
  const user = await r.connect();
  const { id } = await createWs(user);
  r.git(dirOf(r, id), "commit", "-q", "--allow-empty", "-m", "not merged");
  const res = await user.call(WT, "finalise", { id, outcome: "merged" }, newKey());
  assert.equal(res.error?.code, "E_CONFLICT");
  const intent = rows(r, "worktree.finalise.intent");
  assert.equal(intent.length, 1);
  assert.match(intent[0]?.payload ?? "", /started/);
  const result = rows(r, "worktree.finalise");
  assert.equal(result.length, 1);
  assert.equal(result[0]?.outcome, "denied");
  assert.match(result[0]?.payload ?? "", /refused/);
  // A success writes intent then a success row.
  assert.equal((await user.call(WT, "finalise", { id, outcome: "abandoned" }, newKey())).ok, true);
  assert.deepEqual(rows(r, "worktree.finalise").map((x) => x.outcome), ["denied", "success"]);
  assert.equal(rows(r, "worktree.finalise.intent").length, 2);
});

test("recovery refuses while git configuration that can run commands has drifted", { skip }, async (t) => {
  const { r, id } = await interrupted(t);
  r.git(r.repo, "config", "core.hooksPath", path.join(r.tmp, "hooks"));
  await assert.rejects(r.binding.service.finalise({ id, outcome: "archived" }, svc), (e: unknown) => e instanceof DaemonError && e.details?.["reason"] === "git_drift");
  assert.equal(r.journal.getWorkspace(id)?.state, "READY");
  r.git(r.repo, "config", "--unset", "core.hooksPath");
  assert.equal((await r.binding.service.finalise({ id, outcome: "archived" }, svc)).state, "FINALISED");
});
