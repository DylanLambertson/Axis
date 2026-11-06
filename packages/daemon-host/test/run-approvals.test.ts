// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Challenge } from "@axis/protocol";
import type { RunApprovalInput, RunApprovalOutcome } from "../src/index.js";
import { rig, type Rig } from "./approvals-rig.js";

// DMN-3 (ROADMAP 1b gate): a requested approval blocks the action until the user resolves it; an agent actor resolving
// it is denied. These run over the real ChallengeManager, the real axis.approvals/1 handlers and the rule-table policy.

const RUN = "3f2c7a10-1b2c-4d5e-8f90-a1b2c3d4e5f6";
const DIGEST = "ab".repeat(32);
const input = (over: Partial<RunApprovalInput> = {}): RunApprovalInput => ({ runId: RUN, windowId: "win-1", tool: "write_file", tier: "write", digest: DIGEST, reasons: ["protected:github"], ...over });

async function setup(t: TestContext): Promise<Rig> {
  const r = await rig();
  t.after(() => r.cleanup());
  return r;
}

/** Start a request and wait until its challenge is issued (listed). */
async function ask(r: Rig, over: Partial<RunApprovalInput> = {}, signal = new AbortController().signal) {
  let issued: Challenge | undefined;
  let settled: RunApprovalOutcome | undefined;
  const outcome = r.approvals.runs.request(input(over), signal, (c) => void (issued = c)).then((o) => (settled = o));
  for (let i = 0; i < 50 && issued === undefined && settled === undefined; i++) await new Promise((res) => setImmediate(res));
  return { outcome, issued: () => issued, settled: () => settled };
}

const ticks = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((res) => setImmediate(res));
};

test("DMN-3: the call waits for the user; only the user's approval in the run's window grants it, bound to the call digest", async (t) => {
  const r = await setup(t);
  const user = await r.connect();
  const a = await ask(r);
  const challenge = a.issued();
  assert.ok(challenge, "a challenge was issued");
  assert.equal(challenge.tier, 3);
  assert.equal(challenge.contract, "axis.runs");
  assert.equal(r.approvals.runs.waiting(), 1);
  // Listed for the window that started the run, with a summary built from closed labels only.
  const pending = await user.call("axis.approvals", "pending", {});
  const listed = (pending.result?.["challenges"] as Challenge[]).map((c) => c.challengeId);
  assert.deepEqual(listed, [challenge.challengeId]);
  await ticks();
  assert.equal(a.settled(), undefined, "nothing happens before the user answers");

  const resolved = await user.call("axis.approvals", "resolve", { challengeId: challenge.challengeId, decision: "approve", digest: challenge.digest });
  assert.equal(resolved.ok, true, JSON.stringify(resolved.error));
  const out = await a.outcome;
  assert.equal(out.kind, "granted");
  if (out.kind !== "granted") return;
  assert.equal(out.grant.approvedBy, "user");
  assert.equal(out.grant.digest, DIGEST, "the grant names the broker's call digest");
  assert.match(out.grant.approvalId, /^chl:[0-9a-f]{32}$/);
  assert.equal(out.grant.approvalId.includes(challenge.challengeId), false, "the challenge id itself never leaves");
  assert.ok(out.grant.expiresAt > r.clock.now());
  assert.equal(r.approvals.runs.waiting(), 0);
  assert.deepEqual((await user.call("axis.approvals", "pending", {})).result?.["challenges"], [], "no longer listed");
  // DMN-5: issued, resolved by the user, spent by the run's own requester.
  const phases = r.challengeEvents.map((e) => `${e.actor}:${String(e.payload["phase"])}:${e.outcome}`);
  assert.deepEqual(phases, [`agent:composer.${RUN}:issued:success`, "user:resolve:success", "daemon:authorised:success", "daemon:completed:success"]);
  assert.equal(r.challengeEvents[2]?.payload["approvedBy"], "user");
});

test("DMN-3: an agent actor's resolve is denied by policy and the call keeps waiting; the user's denial then declines it", async (t) => {
  const r = await setup(t);
  const agent = await r.connect(`agent:composer.${RUN}#conn-9#win-1`);
  const user = await r.connect();
  const a = await ask(r);
  const challenge = a.issued() as Challenge;
  for (const decision of ["approve", "deny"]) {
    const res = await agent.call("axis.approvals", "resolve", { challengeId: challenge.challengeId, decision, digest: challenge.digest });
    assert.equal(res.error?.code, "E_POLICY_DENIED", decision);
  }
  await ticks();
  assert.equal(a.settled(), undefined, "still blocked after the agent's attempts");
  // A user of another window cannot answer it either.
  const other = await r.connect("user#conn-3#win-2");
  const wrong = await other.call("axis.approvals", "resolve", { challengeId: challenge.challengeId, decision: "approve", digest: challenge.digest });
  assert.equal(wrong.error?.code, "E_NOT_FOUND");
  await ticks();
  assert.equal(a.settled(), undefined, "still blocked after another window's attempt");
  const denied = await user.call("axis.approvals", "resolve", { challengeId: challenge.challengeId, decision: "deny", digest: challenge.digest });
  assert.equal(denied.result?.["state"], "denied");
  assert.deepEqual(await a.outcome, { kind: "declined", state: "denied" });
});

test("a cancelled call withdraws its challenge; a later approval does nothing", async (t) => {
  const r = await setup(t);
  const user = await r.connect();
  const ac = new AbortController();
  const a = await ask(r, {}, ac.signal);
  const challenge = a.issued() as Challenge;
  ac.abort();
  assert.deepEqual(await a.outcome, { kind: "declined", state: "withdrawn" });
  assert.deepEqual((await user.call("axis.approvals", "pending", {})).result?.["challenges"], []);
  const late = await user.call("axis.approvals", "resolve", { challengeId: challenge.challengeId, decision: "approve", digest: challenge.digest });
  assert.equal(late.ok, false, "a withdrawn challenge cannot be approved");
  assert.equal(r.challengeEvents.some((e) => e.payload["phase"] === "authorised"), false, "nothing was spent");
});

test("an expired challenge declines; a resolve with another digest burns it and declines", async (t) => {
  const r = await setup(t);
  const user = await r.connect();
  const a = await ask(r);
  const c1 = a.issued() as Challenge;
  r.clock.advance(61_000);
  const expired = await user.call("axis.approvals", "resolve", { challengeId: c1.challengeId, decision: "approve", digest: c1.digest });
  assert.equal(expired.result?.["state"], "expired");
  assert.deepEqual(await a.outcome, { kind: "declined", state: "expired" });

  const b = await ask(r);
  const c2 = b.issued() as Challenge;
  const burned = await user.call("axis.approvals", "resolve", { challengeId: c2.challengeId, decision: "approve", digest: "0".repeat(64) });
  assert.equal(burned.error?.code, "E_CONFLICT");
  assert.deepEqual(await b.outcome, { kind: "declined", state: "expired" });
  assert.equal(r.approvals.runs.waiting(), 0);
});

test("destructive and privileged calls, a bad run id or digest, and a disposed host are refused before any challenge exists", async (t) => {
  const r = await setup(t);
  for (const over of [{ tier: "destructive" }, { tier: "privileged" }, { tier: "4" }, { runId: "../x" }, { digest: "nothex" }] as Partial<RunApprovalInput>[]) {
    const a = await ask(r, over);
    assert.deepEqual(await a.outcome, { kind: "declined", state: "refused" }, JSON.stringify(over));
    assert.equal(a.issued(), undefined);
  }
  assert.equal(r.challengeEvents.length, 0, "no challenge was issued");
  const pending = r.approvals.runs.request(input(), new AbortController().signal);
  await ticks();
  r.approvals.runs.dispose();
  assert.deepEqual(await pending, { kind: "declined", state: "withdrawn" }, "dispose ends a wait");
  assert.deepEqual(await r.approvals.runs.request(input(), new AbortController().signal), { kind: "declined", state: "refused" });
});

test("settled() ignores a challenge that is not a run's, and a run's approval cannot be spent by another requester", async (t) => {
  const r = await setup(t);
  const a = await ask(r);
  r.approvals.runs.settled({ challengeId: "x".repeat(43), state: "approved", nativeRequired: false });
  await ticks();
  assert.equal(a.settled(), undefined);
  // The gate's execute path (an RPC retry naming this challenge) is refused: the requester is the run, not a connection.
  const challenge = a.issued() as Challenge;
  const user = await r.connect();
  await user.call("axis.approvals", "resolve", { challengeId: challenge.challengeId, decision: "approve", digest: challenge.digest });
  const out = await a.outcome;
  assert.equal(out.kind, "granted");
  assert.equal(r.challengeEvents.filter((e) => e.payload["phase"] === "authorised").length, 1, "spent exactly once");
});
