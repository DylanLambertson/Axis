// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AuditLog, Redactor } from "@axis/audit";
import { CHALLENGE_PAYLOAD_ALLOWLIST, createChallengeAuditSink } from "../src/index.js";
import { challengeOf, newKey, removePayload, rig, wipePayload, type Msg } from "./approvals-rig.js";
import { trackTimers, wait } from "./helpers.js";

import { approve4, AP, issue4, resolve, retry, setup, waitFor, WT } from "./approvals-helpers.js";
test("full flow: challenge, native.confirm with a proof, resolve as user, the retry runs once, a second retry is refused", async (t) => {
  const { r, user } = await setup(t);
  const i = await issue4(r, user);
  assert.equal(i.challenge.nativeConfirmationRequired, true);
  assert.deepEqual(Object.keys(i.sent).sort(), ["challengeId", "proof", "summary", "type", "windowId"]);
  assert.equal(i.sent["challengeId"], i.challenge.challengeId);
  assert.equal(i.sent["windowId"], "win-1");
  assert.ok(!JSON.stringify(user.all).includes(i.proof), "the proof never reaches a connection");
  assert.equal(r.runs.length, 0);
  await approve4(r, user, i);
  const done = await retry(user, i.challenge.challengeId, i.key);
  assert.equal(done.ok, true);
  assert.deepEqual(done.result, { id: "ws-1", state: "CLEANED" });
  assert.equal(r.runs.length, 1);
  assert.equal((r.runs[0]?.approved as { method: string }).method, "remove");
  assert.deepEqual(r.runs[0]?.payload, { id: "ws-1" }, "the approval field is stripped");
  // The same key from the same connection is a replay: the stored result, no second run.
  assert.deepEqual((await retry(user, i.challenge.challengeId, i.key)).result, done.result);
  assert.equal(r.runs.length, 1);
  // A fresh key reuses the spent challenge: refused.
  const again = await retry(user, i.challenge.challengeId, newKey());
  assert.equal(again.error?.code, "E_CONFLICT");
  assert.equal(r.runs.length, 1);
  assert.deepEqual(r.approvals.stats().native.entries, 0);
});

test("tier 3: no native step, resolve alone approves, once", async (t) => {
  const { r, user } = await setup(t);
  const key = newKey();
  const first = await user.call("axis.test", "wipe", wipePayload(), key);
  assert.equal(first.error?.code, "E_APPROVAL_REQUIRED");
  const c = challengeOf(first);
  assert.equal(c.nativeConfirmationRequired, false);
  assert.equal(r.nativeConfirms().length, 0);
  assert.deepEqual((await resolve(user, c)).result, { challengeId: c.challengeId, state: "approved", nativeRequired: false });
  const ok = await user.call("axis.test", "wipe", wipePayload({ approval: { challengeId: c.challengeId } }), key);
  assert.equal(ok.ok, true);
  const second = await user.call("axis.test", "wipe", wipePayload({ approval: { challengeId: c.challengeId } }), newKey());
  assert.equal(second.error?.code, "E_CONFLICT");
  assert.equal(r.runs.length, 1);
});

test("an approved challenge cannot be used before the native dialog confirms it", async (t) => {
  const { r, user } = await setup(t);
  const i = await issue4(r, user);
  assert.equal((await resolve(user, i.challenge)).ok, true);
  assert.equal((await retry(user, i.challenge.challengeId, i.key)).error?.code, "E_CONFLICT");
  assert.equal(r.runs.length, 0);
});

test("the dialog's answer may arrive before the user's resolve: it is held and applied on approval", async (t) => {
  const { r, user } = await setup(t);
  const i = await issue4(r, user);
  r.answer(i.challenge.challengeId, i.proof, true);
  await wait(30);
  assert.equal(r.approvals.stats().native.entries, 1, "held, not applied");
  assert.equal((await retry(user, i.challenge.challengeId, i.key)).error?.code, "E_CONFLICT");
  const res = await resolve(user, i.challenge);
  assert.equal(res.ok, true);
  await waitFor(() => r.approvals.stats().native.confirmed === 1);
  assert.equal((await retry(user, i.challenge.challengeId, newKey())).ok, true);
});

test("a native answer held before the user denies is dropped", async (t) => {
  const { r, user } = await setup(t);
  const i = await issue4(r, user);
  r.answer(i.challenge.challengeId, i.proof, true);
  await wait(30);
  assert.deepEqual((await resolve(user, i.challenge, "deny")).result, { challengeId: i.challenge.challengeId, state: "denied", nativeRequired: true });
  assert.equal(r.approvals.stats().native.entries, 0);
  assert.equal(r.approvals.stats().native.confirmed, 0);
  assert.equal((await retry(user, i.challenge.challengeId, i.key)).error?.code, "E_CONFLICT");
});

test("user cancellation in the native dialog is a refusal", async (t) => {
  const { r, user } = await setup(t);
  const i = await issue4(r, user);
  await approve4(r, user, i, false);
  assert.equal(r.approvals.stats().native.refused, 1);
  assert.equal((await retry(user, i.challenge.challengeId, i.key)).error?.code, "E_CONFLICT");
  assert.equal(r.runs.length, 0);
});

test("a supervisor that never answers (timeout) and a closed channel are refusals, never approvals", async (t) => {
  const { r, user } = await setup(t, { limits: { challengeTtlMs: 120 } });
  const i = await issue4(r, user);
  await wait(250);
  assert.equal((await resolve(user, i.challenge)).ok, true);
  await waitFor(() => r.approvals.stats().native.failed === 1);
  assert.equal(r.approvals.stats().native.confirmed, 0);
  assert.equal((await retry(user, i.challenge.challengeId, i.key)).error?.code, "E_CONFLICT");
  assert.equal(r.runs.length, 0);
});

test("a channel that closes under a waiting dialog withdraws the challenge: the user is never left with one that cannot succeed", async (t) => {
  const { r, user } = await setup(t);
  const j = await issue4(r, user);
  r.peer.close();
  await waitFor(() => r.approvals.stats().native.lost === 1);
  assert.equal(r.approvals.stats().pending, 0);
  assert.equal((await resolve(user, j.challenge)).error?.code, "E_NOT_FOUND");
  assert.equal((await retry(user, j.challenge.challengeId, j.key)).error?.code, "E_POLICY_DENIED");
  assert.equal(r.runs.length, 0);
});

test("a native step refused at once (control client closed, or out of slots) fails the request with nothing issued or listed", async (t) => {
  const closed = await setup(t);
  closed.r.control.dispose();
  const a = await closed.user.call(WT, "remove", removePayload(), newKey());
  assert.equal(a.error?.code, "E_INTERNAL");
  assert.equal(closed.r.approvals.stats().pending, 0);
  assert.deepEqual((await closed.user.call(AP, "pending", {})).result, { challenges: [] });
  const full = await setup(t, { controlMaxPending: 1 });
  await issue4(full.r, full.user);
  const b = await full.user.call(WT, "remove", removePayload({ id: "ws-2" }), newKey());
  assert.equal(b.error?.code, "E_BACKPRESSURE");
  assert.equal(full.r.approvals.stats().pending, 1);
  assert.equal(full.r.control.stats().pending, 1);
});

test("native waits are capped below the control client's slots, so they cannot starve other control requests", async (t) => {
  const { r, user } = await setup(t, { nativeWaitLimit: 2, nativeWaitPerWindow: 2, controlMaxPending: 4 });
  await issue4(r, user, { id: "ws-1" });
  await issue4(r, user, { id: "ws-2" });
  const third = await user.call(WT, "remove", removePayload({ id: "ws-3" }), newKey());
  assert.equal(third.error?.code, "E_BACKPRESSURE");
  assert.equal(r.control.stats().pending, 2);
  const setting = r.control.settingsGet("axis.cliAgents", { timeoutMs: 1000 });
  await waitFor(() => r.supervisor.some((m) => m["type"] === "settings.get"));
  assert.equal(r.control.stats().pending, 3, "a free slot remains for the other requests");
  r.peer.send({ type: "settings.result", requestId: r.supervisor.find((m) => m["type"] === "settings.get")?.["requestId"], key: "axis.cliAgents", value: [] });
  assert.deepEqual(await setting, []);
});

test("a bad digest burns the challenge: its dialog wait is cancelled, a late answer is ignored, and nothing is listed", async (t) => {
  const { r, user } = await setup(t);
  const i = await issue4(r, user);
  const bad = await user.call(AP, "resolve", { challengeId: i.challenge.challengeId, decision: "approve", digest: "1".repeat(64) });
  assert.equal(bad.error?.code, "E_CONFLICT");
  assert.equal(r.approvals.stats().native.entries, 0);
  assert.equal(r.control.stats().pending, 0);
  assert.deepEqual((await user.call(AP, "pending", {})).result, { challenges: [] });
  r.answer(i.challenge.challengeId, i.proof, true);
  await waitFor(() => r.control.stats().ignoredAnswers === 1);
  assert.equal((await retry(user, i.challenge.challengeId, i.key)).error?.code, "E_CONFLICT");
  // A second approve while the dialog is open is refused but leaves the dialog alone.
  const k = await issue4(r, user, { id: "ws-2" });
  await resolve(user, k.challenge);
  assert.equal((await resolve(user, k.challenge)).error?.code, "E_CONFLICT");
  assert.equal(r.approvals.stats().native.entries, 1);
  assert.equal(r.control.stats().pending, 1);
});

test("once the user has approved, the challenge is no longer listed as something to answer", async (t) => {
  const { r, user } = await setup(t);
  const i = await issue4(r, user);
  await resolve(user, i.challenge);
  assert.deepEqual((await user.call(AP, "pending", {})).result, { challenges: [] });
  assert.equal(r.approvals.stats().native.entries, 1);
});

test("the stored audit rows say which action was approved (real AuditLog), and carry no id or proof", async (t) => {
  const db = new DatabaseSync(":memory:");
  const log = new AuditLog(db, { redactor: new Redactor(), payloadAllowlist: CHALLENGE_PAYLOAD_ALLOWLIST });
  const { r, user } = await setup(t, { audit: createChallengeAuditSink(log) });
  const i = await issue4(r, user);
  await approve4(r, user, i);
  await retry(user, i.challenge.challengeId, i.key);
  const rows = log.list({ limit: 50 }).filter((e) => e.action.startsWith("tier4."));
  assert.ok(rows.length >= 5);
  for (const row of rows) assert.equal((row.payload as Record<string, unknown>)["method"], "remove", `${row.action} lacks the method`);
  const text = JSON.stringify(rows);
  assert.ok(!text.includes(i.proof) && !text.includes(i.challenge.challengeId));
  assert.ok(!JSON.stringify(new AuditLog(new DatabaseSync(":memory:")).list()).includes("method"));
  db.close();
});

test("the dialog names the action: the summary starts with the policy-table key, whatever the target", async (t) => {
  const { r, user } = await setup(t);
  const i = await issue4(r, user);
  assert.match(String(i.sent["summary"]), /^axis\.worktrees\/1\.remove: /);
  assert.ok(String(i.sent["summary"]).length <= 192);
});

test("unsolicited, mismatched and wrong-proof native.result messages are ignored and counted", async (t) => {
  const { r, user } = await setup(t);
  r.answer("U".repeat(43), "p".repeat(32), true);
  const i = await issue4(r, user);
  r.answer(i.challenge.challengeId, "w".repeat(32), true); // wrong proof
  r.answer(i.challenge.challengeId, i.proof, true, "win-9"); // wrong window
  r.answer("V".repeat(43), i.proof, true); // another challenge
  await waitFor(() => r.control.stats().ignoredAnswers === 4);
  assert.equal(r.approvals.stats().native.confirmed, 0);
  assert.equal((await resolve(user, i.challenge)).ok, true);
  assert.equal((await retry(user, i.challenge.challengeId, i.key)).error?.code, "E_CONFLICT", "none of them confirmed it");
  // The real answer still works afterwards.
  r.answer(i.challenge.challengeId, i.proof, true);
  await waitFor(() => r.approvals.stats().native.confirmed === 1);
  assert.equal((await retry(user, i.challenge.challengeId, newKey())).ok, true);
});

test("an agent cannot resolve: policy denies, and the handler refuses on its own when the policy is wrong; the challenge stays usable", async (t) => {
  const { r, user } = await setup(t);
  const i = await issue4(r, user);
  const agent = await r.connect("agent:build#conn-2#win-1");
  const denied = await agent.call(AP, "resolve", { challengeId: i.challenge.challengeId, decision: "approve", digest: i.challenge.digest });
  assert.equal(denied.error?.code, "E_POLICY_DENIED");
  const listed = await agent.call(AP, "pending", {});
  assert.equal(listed.error?.code, "E_POLICY_DENIED");
  // Same window, a policy that lets everything through: the handler still refuses the non-user actor.
  const lax = await setup(t, { policy: { evaluate: () => ({ effect: "allow" }) } });
  const j = await issue4(lax.r, lax.user);
  const agent2 = await lax.r.connect("agent:build#conn-2#win-1");
  const res = await agent2.call(AP, "resolve", { challengeId: j.challenge.challengeId, decision: "approve", digest: j.challenge.digest });
  assert.equal(res.error?.code, "E_NOT_FOUND");
  assert.equal((await agent2.call(AP, "pending", {})).error?.code, "E_NOT_FOUND");
  // Nothing was burned: the user still completes the flow.
  await approve4(lax.r, lax.user, j);
  assert.equal((await retry(lax.user, j.challenge.challengeId, j.key)).ok, true);
});

test("another window and an unknown id get the same refusal; neither burns the challenge", async (t) => {
  const { r, user } = await setup(t);
  const i = await issue4(r, user);
  const other = await r.connect("user#conn-3#win-2");
  const wrongWindow = await resolve(other, i.challenge);
  const unknown = await resolve(user, { challengeId: "Z".repeat(43), digest: i.challenge.digest });
  assert.equal(wrongWindow.error?.code, "E_NOT_FOUND");
  assert.deepEqual(wrongWindow.error?.message, unknown.error?.message);
  assert.equal(unknown.error?.code, "E_NOT_FOUND");
  await approve4(r, user, i);
  assert.equal((await retry(user, i.challenge.challengeId, i.key)).ok, true);
});

test("a second resolve of a resolved challenge is refused", async (t) => {
  const { r, user } = await setup(t);
  const i = await issue4(r, user);
  await approve4(r, user, i);
  assert.equal((await resolve(user, i.challenge)).error?.code, "E_CONFLICT");
});

test("expired: the challenge, and an approval that waited too long, are refused", async (t) => {
  const { r, user } = await setup(t);
  const i = await issue4(r, user);
  r.clock.advance(60_001);
  const res = await resolve(user, i.challenge);
  assert.deepEqual(res.result, { challengeId: i.challenge.challengeId, state: "expired", nativeRequired: true });
  assert.equal((await retry(user, i.challenge.challengeId, i.key)).error?.code, "E_CONFLICT");
  const k = await issue4(r, user);
  await approve4(r, user, k);
  r.clock.advance(30_001);
  assert.equal((await retry(user, k.challenge.challengeId, k.key)).error?.code, "E_CONFLICT");
  assert.equal(r.runs.length, 0);
  assert.equal((await user.call(AP, "pending", {})).result?.["challenges"] instanceof Array, true);
});

test("a retry with a different payload is refused, burns the approval, and the handler never runs", async (t) => {
  const { r, user } = await setup(t);
  const i = await issue4(r, user);
  await approve4(r, user, i);
  const other = await retry(user, i.challenge.challengeId, newKey(), { deleteBranch: true });
  assert.equal(other.error?.code, "E_POLICY_DENIED");
  // The exact original request no longer works either: the approval was spent on the mismatch.
  const exact = await retry(user, i.challenge.challengeId, i.key);
  assert.ok(exact.error?.code === "E_CONFLICT");
  assert.equal(r.runs.length, 0);
});

test("a retry on another connection of the same user is refused and does not burn the approval", async (t) => {
  const { r, user } = await setup(t);
  const i = await issue4(r, user);
  await approve4(r, user, i);
  const second = await r.connect("user#conn-4#win-1");
  assert.equal((await retry(second, i.challenge.challengeId, newKey())).error?.code, "E_POLICY_DENIED");
  assert.equal((await retry(user, i.challenge.challengeId, i.key)).ok, true);
});

test("concurrent double use: two retries at once run the action exactly once", async (t) => {
  const { r, user } = await setup(t);
  const i = await issue4(r, user);
  await approve4(r, user, i);
  let release!: () => void;
  const hold = new Promise<void>((res) => (release = res));
  r.holdNextRun(() => hold);
  user.send(WT, "remove", removePayload({ approval: { challengeId: i.challenge.challengeId } }), "c1", newKey());
  user.send(WT, "remove", removePayload({ approval: { challengeId: i.challenge.challengeId } }), "c2", newKey());
  await waitFor(() => r.runs.length >= 1);
  const loser = await user.until((m) => (m.id === "c1" || m.id === "c2") && m.ok === false);
  release();
  const both = await Promise.all([user.until((m) => m.id === "c1"), user.until((m) => m.id === "c2")]);
  assert.equal(both.filter((m) => m.ok === true).length, 1);
  assert.equal(loser.error?.code, "E_CONFLICT");
  assert.equal(r.runs.length, 1);
});

test("the quota is a retryable E_BACKPRESSURE, not an internal error", async (t) => {
  const { r, user } = await setup(t, { limits: { maxOutstandingPerActor: 1, maxOutstandingPerActorOverall: 1 } });
  await issue4(r, user);
  const second = await user.call(WT, "remove", removePayload({ id: "ws-2" }), newKey());
  assert.equal(second.error?.code, "E_BACKPRESSURE");
});

test("pending lists the caller's own window only and drops a challenge once it is resolved or used", async (t) => {
  const { r, user } = await setup(t);
  const other = await r.connect("user#conn-3#win-2");
  const i = await issue4(r, user);
  const mine = (await user.call(AP, "pending", {})).result as { challenges: Array<{ challengeId: string; targetSummary: string }> };
  assert.deepEqual(mine.challenges.map((c) => c.challengeId), [i.challenge.challengeId]);
  assert.equal(mine.challenges[0]?.targetSummary, i.challenge.targetSummary);
  assert.deepEqual((await other.call(AP, "pending", {})).result, { challenges: [] });
  await approve4(r, user, i);
  assert.deepEqual((await retry(user, i.challenge.challengeId, i.key)).ok, true);
  assert.deepEqual((await user.call(AP, "pending", {})).result, { challenges: [] });
});

test("closing the connection withdraws its challenges and cancels the native wait; nothing is left behind", async (t) => {
  const { r, user } = await setup(t);
  const i = await issue4(r, user);
  assert.equal(r.control.stats().pending, 1);
  user.port.close();
  await waitFor(() => r.approvals.stats().native.entries === 0);
  assert.equal(r.approvals.stats().pending, 0);
  assert.equal(r.control.stats().pending, 0, "the control request was cancelled");
  const fresh = await r.connect("user#conn-5#win-1");
  assert.equal((await resolve(fresh, i.challenge)).error?.code, "E_NOT_FOUND");
});

test("a failing audit write stops the challenge from being issued (fail closed) and nothing is listed", async (t) => {
  const { r, user } = await setup(t, { failAudit: (e) => e.payload["phase"] === "issued" });
  const res = await user.call(WT, "remove", removePayload(), newKey());
  assert.equal(res.error?.code, "E_INTERNAL");
  assert.equal(r.approvals.stats().pending, 0);
  assert.equal(r.nativeConfirms().length, 0);
});

test("audit: issue, resolve, native, authorise and completion are each recorded once, with no proof and no challenge id", async (t) => {
  const { r, user } = await setup(t);
  const i = await issue4(r, user);
  await approve4(r, user, i);
  await retry(user, i.challenge.challengeId, i.key);
  const phases = r.challengeEvents.map((e) => `${e.action}:${String(e.payload["phase"])}:${e.outcome}`);
  assert.deepEqual(phases, [
    "tier4.challenge:issued:success",
    "tier4.challenge:resolve:success",
    "tier4.challenge:native:success",
    "tier4.execute:authorised:success",
    "tier4.execute:completed:success",
  ]);
  const text = JSON.stringify(r.challengeEvents) + JSON.stringify(r.rpcEvents);
  assert.ok(!text.includes(i.proof) && !text.includes(i.challenge.challengeId));
});

test("errors echo no caller text and no proofs, on the wire or in the audit", async (t) => {
  const { r, user } = await setup(t);
  const canary = "canary-xyz-text";
  const i = await issue4(r, user, { id: canary });
  const answers: Msg[] = [];
  answers.push(await resolve(user, { challengeId: "Z".repeat(43), digest: "0".repeat(64) }));
  answers.push(await user.call(AP, "resolve", { challengeId: i.challenge.challengeId, decision: "approve", digest: "1".repeat(64) })); // burns
  answers.push(await retry(user, i.challenge.challengeId, newKey(), { id: canary }));
  answers.push(await user.call(AP, "resolve", { challengeId: i.challenge.challengeId, decision: "approve", digest: "1".repeat(64), who: canary }));
  const bad = JSON.stringify(answers);
  for (const secret of [i.proof, i.challenge.challengeId, canary, i.challenge.digest]) assert.ok(!bad.includes(secret), `leaked ${secret.slice(0, 6)}`);
  assert.ok(!JSON.stringify(r.challengeEvents).includes(canary) && !JSON.stringify(r.challengeEvents).includes(i.proof));
  for (const a of answers) assert.equal(a.ok, false);
});

test("no timer or control wait is left behind after a full flow, an abandoned challenge and dispose", async () => {
  const timers = trackTimers();
  try {
    const r = await rig();
    const user = await r.connect();
    const i = await issue4(r, user);
    await approve4(r, user, i);
    await retry(user, i.challenge.challengeId, i.key);
    await issue4(r, user, { id: "ws-2" }); // abandoned: its native wait is still open
    assert.equal(r.control.stats().pending, 1);
    await r.cleanup();
    await wait(20);
    assert.equal(r.control.stats().pending, 0);
    assert.equal(timers.live(), 0);
  } finally {
    timers.restore();
  }
});

test("a challenge belongs to the window that issued it: its dialog, listing and resolve are that window's", async (t) => {
  const { r } = await setup(t);
  const w2 = await r.connect("user#conn-7#win-2");
  const first = await w2.call(WT, "remove", removePayload(), newKey());
  const c = challengeOf(first);
  await waitFor(() => r.nativeConfirms().length === 1);
  assert.equal(r.nativeConfirms()[0]?.["windowId"], "win-2");
  const w1 = await r.connect("user#conn-8#win-1");
  assert.equal((await resolve(w1, c)).error?.code, "E_NOT_FOUND");
  assert.equal((await resolve(w2, c)).ok, true);
});
