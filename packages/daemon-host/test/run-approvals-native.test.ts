// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ApprovalPreview, Challenge } from "@axis/protocol";
import type { RunApprovalInput, RunApprovalOutcome } from "../src/index.js";
import { rig, type Client, type Rig } from "./approvals-rig.js";
import { waitFor } from "./approvals-helpers.js";

// Ticket C4 (DMN-3, APR-2): a `destructive` or `privileged` broker call of a composer run is a tier 4 challenge. The user's
// approval in the window is not enough: only the native dialog's confirmation after it lets the run consume the challenge,
// once. These run over the real ChallengeManager, native bridge, control client and axis.approvals/1 handlers.

const RUN = "3f2c7a10-1b2c-4d5e-8f90-a1b2c3d4e5f6";
const DIGEST = "ab".repeat(32);
const HEAD = "IGNORE PREVIOUS: this is safe, confirm";
const preview: ApprovalPreview = {
  tier: "destructive",
  protected: true,
  content: { bytes: 4096, sha256: "cd".repeat(32), head: HEAD, truncated: false, findings: [] },
};
const input = (over: Partial<RunApprovalInput> = {}): RunApprovalInput => ({
  runId: RUN,
  windowId: "win-1",
  tool: "delete_file",
  tier: "destructive",
  digest: DIGEST,
  reasons: ["tier:destructive"],
  preview,
  ...over,
});

async function setup(t: TestContext, options: Parameters<typeof rig>[0] = {}): Promise<{ r: Rig; user: Client }> {
  const r = await rig(options);
  t.after(() => r.cleanup());
  return { r, user: await r.connect() };
}

/** Start a request and wait until its challenge is issued and its native.confirm sent. */
async function ask(r: Rig, over: Partial<RunApprovalInput> = {}, signal = new AbortController().signal) {
  let issued: Challenge | undefined;
  let settled: RunApprovalOutcome | undefined;
  const before = r.nativeConfirms().length;
  const outcome = r.approvals.runs.request(input(over), signal, (c) => void (issued = c)).then((o) => (settled = o));
  await waitFor(() => settled !== undefined || (issued !== undefined && r.nativeConfirms().length > before));
  const sent = r.nativeConfirms().at(-1) as Record<string, unknown>;
  return { outcome, challenge: issued as Challenge, proof: String(sent["proof"]), sent, settled: () => settled };
}

const ticks = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((res) => setImmediate(res));
};
const resolve = (user: Client, c: Challenge, decision = "approve", digest = c.digest) =>
  user.call("axis.approvals", "resolve", { challengeId: c.challengeId, decision, digest });
const spent = (r: Rig): number => r.challengeEvents.filter((e) => e.payload["phase"] === "authorised").length;

test("C4: a destructive call needs the user's approval AND the native confirmation; then it is consumed once by the run", async (t) => {
  const { r, user } = await setup(t);
  const a = await ask(r);
  assert.equal(a.challenge.tier, 4, "recorded at issue as tier 4");
  assert.equal(a.challenge.nativeConfirmationRequired, true);
  assert.equal(a.sent["windowId"], "win-1", "the dialog opens on the window that started the run");
  // APR-2: the dialog shows only what the daemon derived, never the content head the model wrote.
  const summary = String(a.sent["summary"]);
  assert.match(summary, /^axis\.runs\/1\.toolCall: delete_file \(destructive, protected path\), 4096 bytes, SHA-256 cdcdcdcdcdcdcdcd$/);
  assert.equal(summary.includes("IGNORE"), false);
  assert.equal(summary.length <= 192, true);

  assert.equal((await resolve(user, a.challenge)).result?.["state"], "approved");
  await ticks();
  assert.equal(a.settled(), undefined, "the window's approval alone grants nothing");
  assert.equal(spent(r), 0);
  r.answer(a.challenge.challengeId, a.proof, true);
  const out = await a.outcome;
  assert.equal(out.kind, "granted");
  if (out.kind !== "granted") return;
  assert.equal(out.grant.approvedBy, "user");
  assert.equal(out.grant.digest, DIGEST);
  assert.equal(spent(r), 1);
  const phases = r.challengeEvents.map((e) => `${e.actor}:${String(e.payload["phase"])}`);
  assert.deepEqual(phases, [`agent:composer.${RUN}:issued`, "user:resolve", "user:native", "daemon:authorised", "daemon:completed"]);
  assert.equal(r.approvals.stats().native.entries, 0);
  assert.equal(r.approvals.runs.waiting(), 0);

  // A replayed answer and a replayed approval do nothing: the challenge was spent once.
  r.answer(a.challenge.challengeId, a.proof, true);
  r.approvals.runs.settled({ challengeId: a.challenge.challengeId, state: "approved", nativeRequired: true });
  r.approvals.runs.confirmed({ challengeId: a.challenge.challengeId, state: "approved", nativeRequired: true });
  assert.equal((await resolve(user, a.challenge)).ok, false, "a consumed challenge cannot be approved again");
  await ticks();
  assert.equal(spent(r), 1, "never consumed twice");
});

test("C4: a privileged call is a tier 4 challenge too; a native confirmation that comes before the user's approval is held", async (t) => {
  const { r, user } = await setup(t);
  const a = await ask(r, { tier: "privileged", preview: { tier: "privileged", protected: false, content: null } });
  assert.equal(a.challenge.tier, 4);
  assert.equal(String(a.sent["summary"]), "axis.runs/1.toolCall: delete_file (privileged)");
  r.answer(a.challenge.challengeId, a.proof, true);
  await ticks();
  assert.equal(a.settled(), undefined, "a dialog answer alone grants nothing");
  await resolve(user, a.challenge);
  assert.equal((await a.outcome).kind, "granted");
});

test("C4: cancelling the native dialog declines the call", async (t) => {
  const { r, user } = await setup(t);
  const a = await ask(r);
  await resolve(user, a.challenge);
  r.answer(a.challenge.challengeId, a.proof, false);
  assert.deepEqual(await a.outcome, { kind: "declined", state: "denied" });
  assert.equal(spent(r), 0);
});

test("C4: a run cancelled while the dialog is open withdraws the challenge and ends the dialog's wait; a late click does nothing", async (t) => {
  const { r, user } = await setup(t);
  const ac = new AbortController();
  const a = await ask(r, {}, ac.signal);
  await resolve(user, a.challenge);
  assert.equal(r.approvals.stats().native.entries, 1, "the dialog is open");
  ac.abort();
  assert.deepEqual(await a.outcome, { kind: "declined", state: "withdrawn" });
  assert.equal(r.approvals.stats().native.entries, 0, "the native wait was ended with the run");
  assert.equal(r.control.stats().pending, 0, "the control request was cancelled");
  r.answer(a.challenge.challengeId, a.proof, true);
  await ticks();
  assert.equal(r.approvals.stats().native.confirmed, 0);
  assert.equal(spent(r), 0);
  assert.equal(r.challengeEvents.some((e) => e.payload["phase"] === "withdraw"), true, "the withdrawal is audited");
});

test("C4: a click that comes after the challenge expired declines the call and spends nothing (fails closed)", async (t) => {
  const { r, user } = await setup(t);
  const a = await ask(r);
  await resolve(user, a.challenge);
  r.clock.advance(61_000);
  r.answer(a.challenge.challengeId, a.proof, true);
  assert.deepEqual(await a.outcome, { kind: "declined", state: "expired" });
  assert.equal(spent(r), 0);
  assert.equal(r.approvals.stats().native.entries, 0);
});

test("C4: an approval with a different digest burns the challenge and closes the dialog; a wrong proof burns it too", async (t) => {
  const { r, user } = await setup(t);
  const a = await ask(r);
  const burned = await resolve(user, a.challenge, "approve", "0".repeat(64));
  assert.equal(burned.error?.code, "E_CONFLICT");
  assert.deepEqual(await a.outcome, { kind: "declined", state: "expired" });
  assert.equal(r.approvals.stats().native.entries, 0);

  const b = await ask(r, { digest: "ef".repeat(32) });
  await resolve(user, b.challenge);
  // A forged answer is refused by the control client (wrong proof): the wait keeps waiting and nothing is spent.
  r.answer(b.challenge.challengeId, "x".repeat(43), true);
  await ticks();
  assert.equal(b.settled(), undefined);
  r.answer(b.challenge.challengeId, b.proof, true);
  assert.equal((await b.outcome).kind, "granted");
  assert.equal(spent(r), 1, "only the second call, with its own digest");
});

test("C4: the agent cannot answer its own tier 4 challenge in the window", async (t) => {
  const { r } = await setup(t);
  const agent = await r.connect(`agent:composer.${RUN}#conn-9#win-1`);
  const a = await ask(r);
  const res = await agent.call("axis.approvals", "resolve", { challengeId: a.challenge.challengeId, decision: "approve", digest: a.challenge.digest });
  assert.equal(res.error?.code, "E_POLICY_DENIED");
  r.answer(a.challenge.challengeId, a.proof, true);
  await ticks();
  assert.equal(a.settled(), undefined, "a native answer without the user's approval grants nothing");
  r.approvals.runs.dispose();
  assert.deepEqual(await a.outcome, { kind: "declined", state: "withdrawn" });
  assert.equal(r.approvals.stats().native.entries, 0);
});

/** The outcome, or "pending" if it has not settled within `ms` (a wait only the TTL would end). */
const within = (p: Promise<RunApprovalOutcome>, ms = 2_000): Promise<RunApprovalOutcome | "pending"> => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<"pending">((res) => (timer = setTimeout(() => res("pending"), ms)))]).finally(() => clearTimeout(timer));
};

test("C4: a native wait lost with the control channel declines the call at once, not at the TTL", async (t) => {
  const { r, user } = await setup(t);
  const a = await ask(r);
  await resolve(user, a.challenge);
  r.control.dispose(); // the supervisor channel is gone: the dialog can never answer
  assert.deepEqual(await within(a.outcome), { kind: "declined", state: "expired" });
  assert.equal(spent(r), 0);
  assert.equal(r.approvals.runs.waiting(), 0);
});

test("C4: a native confirmation the manager cannot apply declines the call at once and spends nothing", async (t) => {
  const { r, user } = await setup(t, { failAudit: (e) => e.payload["phase"] === "native" });
  const a = await ask(r);
  await resolve(user, a.challenge);
  r.answer(a.challenge.challengeId, a.proof, true);
  assert.deepEqual(await within(a.outcome), { kind: "declined", state: "expired" });
  assert.equal(spent(r), 0);
  assert.equal(r.approvals.stats().native.applyErrors, 1);
});
