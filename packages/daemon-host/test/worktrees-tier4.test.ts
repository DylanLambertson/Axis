// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import * as path from "node:path";
import { challengeOf, newKey, type Client } from "./approvals-rig.js";
import { wait } from "./helpers.js";
import { createWorktreesHandlers } from "../src/index.js";
import { createWs as createWsRaw, finaliseApproved, gitSkipReason, worktreesRig, type Rig } from "./worktrees-rig.js";

// Ticket P1d: `axis.worktrees/1.finalise` is tier 4 (challenge plus native confirmation), because a discard token is minted
// only for a challenge issued at tier 4 or above; `discard` and `setUserEditing` are served but not backed yet.
const skip = gitSkipReason();
const WT = "axis.worktrees";
const AP = "axis.approvals";
const createWs = async (user: Client): Promise<string> => (await createWsRaw(user, (_m, x) => (assert.equal(x.ok, true, JSON.stringify(x.error)), x))).id;

async function setup(t: TestContext): Promise<{ r: Rig; user: Client }> {
  const r = await worktreesRig();
  t.after(() => r.cleanup());
  return { r, user: await r.connect() };
}

test("finalise without an approval is a tier 4 challenge with a native dialog and changes nothing", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const id = await createWs(user);
  const first = await user.call(WT, "finalise", { id, outcome: "archived" }, newKey());
  assert.equal(first.error?.code, "E_APPROVAL_REQUIRED", JSON.stringify(first.error));
  const challenge = challengeOf(first);
  assert.equal(challenge.tier, 4);
  assert.equal(challenge.nativeConfirmationRequired, true);
  assert.equal(challenge.method, "finalise");
  assert.equal(r.journal.getWorkspace(id)?.state, "READY");
  assert.equal(r.git(r.repo, "for-each-ref", "refs/axis/archive").includes(id), false, "nothing was archived");
});

test("finalise: an approval that the native dialog has not confirmed does not run it; the confirmed one does, once", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const id = await createWs(user);
  const key = newKey();
  const first = await user.call(WT, "finalise", { id, outcome: "archived" }, key);
  const c = challengeOf(first);
  const resolved = await user.call(AP, "resolve", { challengeId: c.challengeId, decision: "approve", digest: c.digest });
  assert.equal(resolved.ok, true);
  const early = await user.call(WT, "finalise", { id, outcome: "archived", approval: { challengeId: c.challengeId } }, key);
  assert.equal(early.ok, false, "approved in the window but not natively confirmed");
  assert.equal(r.journal.getWorkspace(id)?.state, "READY");
  const proof = String((r.nativeConfirms().at(-1) as Record<string, unknown>)["proof"]);
  r.answer(c.challengeId, proof, true);
  for (let i = 0; r.approvals.stats().native.entries !== 0; i++) {
    assert.ok(i < 400, "the native answer was applied");
    await wait(5);
  }
  const done = await user.call(WT, "finalise", { id, outcome: "archived", approval: { challengeId: c.challengeId } }, key);
  assert.equal(done.ok, true, JSON.stringify(done.error));
  assert.equal(r.journal.getWorkspace(id)?.state, "FINALISED");
  const again = await user.call(WT, "finalise", { id, outcome: "archived", approval: { challengeId: c.challengeId } }, newKey());
  assert.equal(again.ok, false, "the spent approval does not run a second finalise");
});

test("finalise: a dirty workspace is finalised only after the native confirmation, and the dirty file is backed up", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const id = await createWs(user);
  const dir = String(r.journal.getWorkspace(id)?.worktreePath);
  writeFileSync(path.join(dir, "a.txt"), "unsaved work\n");
  const done = await finaliseApproved(r, user, id, "archived");
  assert.equal(done.ok, true, JSON.stringify(done.error));
  assert.equal(r.journal.getWorkspace(id)?.state, "FINALISED");
  assert.equal(r.git(r.repo, "for-each-ref", "refs/axis/backup").includes(id), true, "a backup ref holds the dirty file");
});

test("discard and setUserEditing are served (policy and schema) but answer a fixed E_UNAVAILABLE until a service backs them", { skip }, async (t) => {
  const { r, user } = await setup(t);
  const id = await createWs(user);
  const before = r.journal.transitions("workspace", id).length;
  const discard = await user.call(WT, "discard", { id, paths: ["a.txt"] }, newKey());
  assert.deepEqual([discard.error?.code, discard.error?.details], ["E_UNAVAILABLE", { reason: "not_available" }]);
  const editing = await user.call(WT, "setUserEditing", { id, paths: ["a.txt"] });
  assert.deepEqual([editing.error?.code, editing.error?.details], ["E_UNAVAILABLE", { reason: "not_available" }]);
  // Arguments are validated before the handler: a bad path is a schema error, not that refusal.
  assert.equal((await user.call(WT, "discard", { id, paths: ["../x"] }, newKey())).error?.code, "E_INVALID_ARGUMENT");
  assert.equal((await user.call(WT, "setUserEditing", { id, paths: [".git/config"] })).error?.code, "E_INVALID_ARGUMENT");
  const agent = await r.connect("agent:x#conn-9#win-1");
  assert.equal((await agent.call(WT, "discard", { id, paths: ["a.txt"] }, newKey())).error?.code, "E_POLICY_DENIED");
  assert.equal((await agent.call(WT, "setUserEditing", { id, paths: [] })).error?.code, "E_POLICY_DENIED");
  assert.equal(r.journal.transitions("workspace", id).length, before, "nothing changed");
});

test("the finalise and remove handlers stop with E_INTERNAL when they run outside a spent approval (defence in depth)", async () => {
  let called = 0;
  const service = new Proxy({}, { get: () => async () => (called++, {}) });
  const handlers = createWorktreesHandlers({ service: service as never, needsAttention: () => false });
  const context = { identity: { actor: "user", connectionId: "c", windowId: "w" }, signal: new AbortController().signal };
  for (const [method, body] of [["finalise", { id: "ws-1", outcome: "archived" }], ["remove", { id: "ws-1" }]] as const) {
    await assert.rejects(Promise.resolve(handlers[method](context as never, body as never)), (e: { code?: string }) => e.code === "E_INTERNAL", method);
  }
  assert.equal(called, 0, "the service was not reached");
});
