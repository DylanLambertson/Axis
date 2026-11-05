// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import * as path from "node:path";
import { DaemonError } from "@axis/daemon";
import { newKey, challengeOf, type Client, type Msg } from "./approvals-rig.js";
import { approve4, waitFor } from "./approvals-helpers.js";
import { createWs as createWsRaw, gitSkipReason, worktreesRig, type Rig, type RigOptions } from "./worktrees-rig.js";

const skip = gitSkipReason();
const WT = "axis.worktrees";
const createWs = (user: Client, name?: string) => createWsRaw(user, (_m, x) => (assert.equal(x.ok, true, JSON.stringify(x.error)), x), name);

async function setup(t: TestContext, options: RigOptions = {}): Promise<{ r: Rig; user: Client }> {
  const r = await worktreesRig(options);
  t.after(() => r.cleanup());
  return { r, user: await r.connect() };
}

const finalised = async (r: Rig, user: Client, name = "Gone"): Promise<{ id: string; dir: string }> => {
  const { id } = await createWs(user, name);
  const fin = await user.call(WT, "finalise", { id, outcome: "archived" }, newKey());
  assert.equal(fin.ok, true);
  return { id, dir: String(r.journal.getWorkspace(id)?.worktreePath) };
};

async function challenge(r: Rig, user: Client, payload: Record<string, unknown>, key = newKey()) {
  const first = await user.call(WT, "remove", payload, key);
  assert.equal(first.error?.code, "E_APPROVAL_REQUIRED", JSON.stringify(first.error));
  const c = challengeOf(first);
  await waitFor(() => r.nativeConfirms().length > 0);
  const sent = r.nativeConfirms().at(-1) as Record<string, unknown>;
  return { c, key, proof: String(sent["proof"]), sent };
}
const retry = (user: Client, id: string, ref: string, key: string, over: Record<string, unknown> = {}): Promise<Msg> =>
  user.call(WT, "remove", { id, approval: { challengeId: ref }, ...over }, key);

test("remove: E_APPROVAL_REQUIRED first, then the approved retry runs once; the journal ends REMOVED and the directory is gone", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const { id, dir } = await finalised(r, user);
  const i = await challenge(r, user, { id });
  assert.equal(i.c.nativeConfirmationRequired, true);
  assert.match(String(i.sent["summary"]), /^axis\.worktrees\/1\.remove: axis\/gone-[0-9a-f]{6}: 0 changed, 0 not backed up$/);
  assert.equal(existsSync(dir), true, "nothing is removed before the approval");
  await approve4(r as never, user, { challenge: i.c, proof: i.proof, key: i.key, sent: i.sent, first: {} as Msg });
  const done = await retry(user, id, i.c.challengeId, i.key);
  assert.equal(done.ok, true, JSON.stringify(done.error));
  assert.deepEqual(done.result, { id, state: "CLEANED" });
  assert.equal(existsSync(dir), false);
  const ws = r.journal.getWorkspace(id);
  assert.equal(ws?.state, "REMOVED");
  assert.equal(ws?.lockState, "unlocked");
  assert.deepEqual(r.journal.transitions("workspace", id).map((x) => x.to), ["CREATING", "READY", "FINALISED", "REMOVING", "REMOVED"]);
  assert.ok(r.db.prepare("SELECT 1 FROM audit_events WHERE action = 'worktree.remove'").get());
  // The same key replays the stored result; a new key reusing the spent challenge is refused; nothing runs twice.
  assert.deepEqual((await retry(user, id, i.c.challengeId, i.key)).result, done.result);
  // The workspace is gone, so the content hook refuses before anything is spent (see the note on hook refusals below).
  assert.equal((await retry(user, id, i.c.challengeId, newKey())).ok, false);
  assert.equal(r.git(r.repo, "worktree", "list", "--porcelain").includes(dir), false);
});

test("remove of a dirty workspace: the confirmation is minted after the spend, the backup is written, a change after the dialog is refused", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const { id, dir } = await finalised(r, user);
  writeFileSync(path.join(dir, "a.txt"), "unsaved work\n");
  writeFileSync(path.join(dir, "ignored.log"), "log\n");
  const first = await challenge(r, user, { id });
  assert.match(String(first.sent["summary"]), /: 1 changed, 1 not backed up$/);
  // Content changes after the challenge was issued: the fingerprint no longer matches what the user saw.
  writeFileSync(path.join(dir, "sub", "b.txt"), "another change\n");
  await approve4(r as never, user, { challenge: first.c, proof: first.proof, key: first.key, sent: first.sent, first: {} as Msg });
  const stale = await retry(user, id, first.c.challengeId, first.key);
  assert.equal(stale.error?.code, "E_CONFLICT");
  assert.equal(existsSync(dir), true, "a stale approval removes nothing");
  assert.equal(r.journal.getWorkspace(id)?.state, "FINALISED");
  // A fresh challenge over the current content works and keeps the work in a backup ref.
  const second = await challenge(r, user, { id });
  assert.match(String(second.sent["summary"]), /: 2 changed, 1 not backed up$/);
  await approve4(r as never, user, { challenge: second.c, proof: second.proof, key: second.key, sent: second.sent, first: {} as Msg });
  const done = await retry(user, id, second.c.challengeId, second.key);
  assert.equal(done.ok, true, JSON.stringify(done.error));
  const backup = (done.result as { backupRef?: string }).backupRef;
  assert.match(String(backup), /^refs\/axis\/backup\//);
  assert.equal(r.git(r.repo, "show", `${backup}:a.txt`), "unsaved work\n");
  assert.equal(existsSync(dir), false);
});

test("remove: a workspace that was not finalised, an unknown id and a non-user caller are refused before any challenge or dialog", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const { id } = await createWs(user);
  // A refusal by the content hook reaches the wire as E_INTERNAL until @axis/daemon maps a hook's DaemonError (see the
  // docs); what matters here is that no challenge and no dialog exist, and nothing changed.
  const early = await user.call(WT, "remove", { id }, newKey());
  assert.equal(early.ok, false);
  assert.notEqual(early.error?.code, "E_APPROVAL_REQUIRED");
  const unknown = await user.call(WT, "remove", { id: "ws-unknown" }, newKey());
  assert.equal(unknown.ok, false);
  assert.notEqual(unknown.error?.code, "E_APPROVAL_REQUIRED");
  const agent = await r.connect("agent:x#conn-3#win-1");
  assert.equal((await agent.call(WT, "remove", { id }, newKey())).error?.code, "E_POLICY_DENIED");
  assert.equal(r.nativeConfirms().length, 0, "no dialog for a call that will be refused");
  assert.equal(r.journal.getWorkspace(id)?.state, "READY");
  assert.deepEqual(r.journal.transitions("workspace", id).map((x) => x.to), ["CREATING", "READY"]);
});

test("remove: refused while a run is active, before the approval is spent; the same approval works once the run ends", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const { id, dir } = await finalised(r, user);
  r.active.add(id);
  const early = await user.call(WT, "remove", { id }, newKey());
  assert.equal(early.ok, false);
  assert.notEqual(early.error?.code, "E_APPROVAL_REQUIRED");
  assert.equal(r.nativeConfirms().length, 0, "no challenge and no dialog while a run is active");
  r.active.clear();
  const i = await challenge(r, user, { id });
  await approve4(r as never, user, { challenge: i.c, proof: i.proof, key: i.key, sent: i.sent, first: {} as Msg });
  r.active.add(id);
  const blocked = await retry(user, id, i.c.challengeId, i.key);
  assert.equal(blocked.ok, false);
  assert.equal(existsSync(dir), true);
  assert.equal(r.journal.getWorkspace(id)?.state, "FINALISED");
  r.active.clear();
  assert.equal((await retry(user, id, i.c.challengeId, i.key)).ok, true, "the approval was not spent by the refusal");
});

test("preflight seam: a stall check throwing refuses tier 4 before any challenge or dialog, and resumes when it clears", { skip }, async (t) => {
  let stalled = true;
  const { r, user } = await setup(t, {
    preflight: () => {
      if (stalled) throw new DaemonError("E_UNAVAILABLE", "stalled");
    },
  });
  const { id } = await finalised(r, user);
  const refused = await user.call(WT, "remove", { id }, newKey());
  assert.equal(refused.ok, false);
  assert.notEqual(refused.error?.code, "E_APPROVAL_REQUIRED");
  assert.equal(r.nativeConfirms().length, 0);
  stalled = false;
  assert.equal((await user.call(WT, "remove", { id }, newKey())).error?.code, "E_APPROVAL_REQUIRED");
});
