// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { challengeOf, newKey, removePayload, rig, type Client, type Rig } from "./approvals-rig.js";
import { wait } from "./helpers.js";

export const WT = "axis.worktrees";
export const AP = "axis.approvals";

export async function setup(t: TestContext, options: Parameters<typeof rig>[0] = {}): Promise<{ r: Rig; user: Client }> {
  const r = await rig(options);
  t.after(() => r.cleanup());
  return { r, user: await r.connect() };
}

/** Issue a tier 4 challenge and return it with the proof the supervisor was given. */
export async function issue4(r: Rig, user: Client, over: Record<string, unknown> = {}, key = newKey()) {
  const first = await user.call(WT, "remove", removePayload(over), key);
  assert.equal(first.error?.code, "E_APPROVAL_REQUIRED");
  const challenge = challengeOf(first);
  await waitFor(() => r.nativeConfirms().length > 0);
  const sent = r.nativeConfirms().at(-1) as Record<string, unknown>;
  return { first, challenge, key, proof: String(sent["proof"]), sent };
}
export async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail("condition not reached");
    await wait(5);
  }
}
export const resolve = (user: Client, challenge: { challengeId: string; digest: string }, decision = "approve") =>
  user.call(AP, "resolve", { challengeId: challenge.challengeId, decision, digest: challenge.digest });
export const retry = (user: Client, id: string, key: string, over: Record<string, unknown> = {}) =>
  user.call(WT, "remove", removePayload({ approval: { challengeId: id }, ...over }), key);
/** Resolve as the user, deliver the dialog's answer and wait until it is applied. */
export async function approve4(r: Rig, user: Client, i: Awaited<ReturnType<typeof issue4>>, confirmed = true): Promise<void> {
  const res = await resolve(user, i.challenge);
  assert.equal(res.ok, true);
  assert.deepEqual(res.result, { challengeId: i.challenge.challengeId, state: "approved", nativeRequired: true });
  r.answer(i.challenge.challengeId, i.proof, confirmed);
  await waitFor(() => r.approvals.stats().native.entries === 0);
}
