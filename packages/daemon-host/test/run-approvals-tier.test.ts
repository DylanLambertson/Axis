// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Challenge } from "@axis/protocol";
import { createRunApprovals, runNativeDetail, type RunApprovalInput, type RunApprovalsCore, type RunNativePort } from "../src/index.js";

// Ticket C4: what `run-approvals` checks itself, over a PERMISSIVE stand-in manager whose `consume` runs any action, so
// each check below is proven by this file alone and not by the real manager behind it (the native flow over the real
// manager is in run-approvals-native.test.ts).

const RUN = "3f2c7a10-1b2c-4d5e-8f90-a1b2c3d4e5f6";
const DIGEST = "ab".repeat(32);
const ID = "c".repeat(43);
const input = (over: Partial<RunApprovalInput> = {}): RunApprovalInput => ({ runId: RUN, windowId: "win-1", tool: "run_command", tier: "destructive", digest: DIGEST, reasons: [], ...over });

function stub(opts: { issuedTier?: number; native?: boolean; startFails?: boolean; noNative?: boolean; full?: boolean } = {}) {
  const log: string[] = [];
  const consumed: Array<{ caller: unknown; context: Record<string, unknown> }> = [];
  const listed: string[] = [];
  const manager: RunApprovalsCore["manager"] = {
    issue: ((req: { tier: number }) => {
      log.push(`issue:${req.tier}`);
      const tier = opts.issuedTier ?? req.tier;
      return { challengeId: ID, digest: "d".repeat(64), tier, nativeConfirmationRequired: opts.native ?? tier >= 4, targetSummary: "Composer tool run_command" } as unknown as Challenge;
    }) as never,
    takeNativeProof: () => "p".repeat(43),
    withdraw: (() => void log.push("withdraw")) as never,
    consume: (async (_id: string, caller: unknown, context: Record<string, unknown>, action: (c: unknown) => unknown) => {
      consumed.push({ caller, context });
      return action({});
    }) as never,
  };
  const native: RunNativePort = {
    reserve: () => (opts.full ? undefined : { release: () => void log.push("release") }),
    start: async (r) => {
      log.push(`start:${r.summary}`);
      if (opts.startFails) throw new Error("closed");
    },
    end: () => void log.push("end"),
  };
  const preflights: number[] = [];
  const runs = createRunApprovals({
    manager,
    preflight: (tier) => void preflights.push(tier),
    listing: { add: (c) => void listed.push(c.challengeId), remove: () => undefined },
    now: () => 1_000,
    ttlMs: 60_000,
    ...(opts.noNative ? {} : { native }),
  });
  return { runs, log, consumed, listed, preflights };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test("the tier is recorded at issue: a manager that issues another tier (or no native step for tier 4) is withdrawn and refused", async () => {
  for (const o of [{ issuedTier: 3 }, { native: false }, { issuedTier: 5 }]) {
    const s = stub(o);
    assert.deepEqual(await s.runs.request(input(), new AbortController().signal), { kind: "declined", state: "refused" }, JSON.stringify(o));
    assert.deepEqual(s.log.filter((l) => !l.startsWith("issue")), ["release", "withdraw"], "no dialog, nothing listed");
    assert.equal(s.listed.length, 0);
    assert.equal(s.consumed.length, 0);
  }
  // A tier 3 call that the manager made native is refused just the same.
  const s = stub({ native: true });
  assert.deepEqual(await s.runs.request(input({ tier: "write" }), new AbortController().signal), { kind: "declined", state: "refused" });
  assert.equal(s.log[0], "issue:3");
});

test("re-checked at consume: a tier 4 wait is never consumed on the window's approval alone, nor on a native answer without it", async () => {
  // A resolve that claims no native step for a tier 4 challenge.
  let s = stub();
  let p = s.runs.request(input(), new AbortController().signal);
  await tick();
  s.runs.settled({ challengeId: ID, state: "approved", nativeRequired: false });
  assert.deepEqual(await p, { kind: "declined", state: "refused" });
  assert.equal(s.consumed.length, 0);
  // A native confirmation with no approval in the window before it.
  s = stub();
  p = s.runs.request(input(), new AbortController().signal);
  await tick();
  s.runs.confirmed({ challengeId: ID, state: "approved", nativeRequired: true });
  assert.deepEqual(await p, { kind: "declined", state: "refused" });
  assert.equal(s.consumed.length, 0);
  // A tier 3 wait never takes a native answer, nor an approval that says one is needed.
  for (const answer of ["confirmed", "settled"] as const) {
    s = stub();
    p = s.runs.request(input({ tier: "write" }), new AbortController().signal);
    await tick();
    s.runs[answer]({ challengeId: ID, state: "approved", nativeRequired: true });
    assert.deepEqual(await p, { kind: "declined", state: "refused" }, answer);
    assert.equal(s.consumed.length, 0);
  }
});

test("consume is bound to the run's requester, its connection and the call digest, and runs once however often the answers come", async () => {
  const s = stub();
  const p = s.runs.request(input(), new AbortController().signal);
  await tick();
  s.runs.settled({ challengeId: ID, state: "approved", nativeRequired: true });
  s.runs.confirmed({ challengeId: ID, state: "approved", nativeRequired: true });
  s.runs.confirmed({ challengeId: ID, state: "approved", nativeRequired: true });
  s.runs.settled({ challengeId: ID, state: "approved", nativeRequired: true });
  const out = await p;
  assert.equal(out.kind, "granted");
  assert.equal(s.consumed.length, 1, "spent once");
  assert.deepEqual(s.consumed[0]?.caller, { actor: `agent:composer.${RUN}`, connectionId: `run.${RUN}` });
  assert.equal(s.consumed[0]?.context["currentContentDigest"], DIGEST);
  assert.deepEqual(s.consumed[0]?.context["args"], { runId: RUN, tool: "run_command", digest: DIGEST, tier: "destructive" });
  assert.equal(s.log.includes("end"), true, "the dialog's wait is ended after the spend");
});

test("fails closed with no native port, or when the dialog cannot be started; the user is never shown that challenge", async () => {
  let s = stub({ noNative: true });
  assert.deepEqual(await s.runs.request(input(), new AbortController().signal), { kind: "declined", state: "refused" });
  assert.deepEqual(s.log, [], "nothing issued");
  let shown = 0;
  s = stub({ startFails: true });
  assert.deepEqual(await s.runs.request(input(), new AbortController().signal, () => void shown++), { kind: "declined", state: "refused" });
  assert.equal(shown, 0);
  assert.equal(s.listed.length, 0);
  assert.equal(s.log.includes("withdraw"), true);
  assert.equal(s.runs.waiting(), 0);
});

test("the native detail is built from daemon-derived values only and refuses a tool name it cannot vouch for", () => {
  const preview = { tier: "destructive" as const, protected: false, content: { bytes: 3, sha256: "0f".repeat(32), head: "rm -rf /", truncated: false, findings: [] } };
  assert.equal(runNativeDetail({ tool: "run_command", tier: "destructive", preview }), "run_command (destructive), 3 bytes, SHA-256 0f0f0f0f0f0f0f0f");
  assert.equal(runNativeDetail({ tool: "Run Command: safe", tier: "destructive" }), undefined);
  assert.equal(runNativeDetail({ tool: "run_command", tier: "root" }), undefined);
  assert.equal(runNativeDetail({ tool: "run_command", tier: "privileged" }), "run_command (privileged)");
});

test("a full native bridge refuses before anything is issued: no challenge, no audit row, no quota used", async () => {
  const s = stub({ full: true });
  let shown = 0;
  let out: unknown;
  const p = s.runs.request(input(), new AbortController().signal, () => void shown++).then((o) => (out = o));
  await tick();
  assert.deepEqual(s.log, [], "nothing was issued (the manager audits and counts every issue)");
  s.runs.dispose(); // ends a wait a broken check would have started
  await p;
  assert.deepEqual(out, { kind: "declined", state: "refused" });
  assert.equal(shown + s.listed.length + s.consumed.length, 0);
});

test("the anchor preflight is asked with the challenge tier: 4 for destructive and privileged, 3 otherwise", async () => {
  for (const [tier, want] of [["destructive", 4], ["privileged", 4], ["write", 3], ["network", 3]] as const) {
    const s = stub();
    const p = s.runs.request(input({ tier }), new AbortController().signal);
    await tick();
    s.runs.dispose();
    await p;
    assert.deepEqual(s.preflights, [want], tier);
  }
});

test("a call cancelled after the native confirmation but before the consume is withdrawn, not consumed", async () => {
  const s = stub();
  const ac = new AbortController();
  const p = s.runs.request(input(), ac.signal);
  await tick();
  s.runs.settled({ challengeId: ID, state: "approved", nativeRequired: true });
  s.runs.confirmed({ challengeId: ID, state: "approved", nativeRequired: true });
  ac.abort(); // before the request's continuation runs
  assert.deepEqual(await p, { kind: "declined", state: "withdrawn" });
  assert.equal(s.consumed.length, 0);
  assert.equal(s.log.includes("withdraw"), true);
});

test("the native line keeps the protected label and the closing parenthesis whole, within 192 units", async () => {
  const s = stub();
  const tool = "a_twenty_one_char_tol";
  const preview = { tier: "destructive" as const, protected: true, content: { bytes: 9_007_199_254_740_991, sha256: "0f".repeat(32), head: "", truncated: true, findings: [] } };
  const p = s.runs.request(input({ tool, preview }), new AbortController().signal);
  await tick();
  s.runs.dispose();
  await p;
  const line = (s.log.find((l) => l.startsWith("start:")) as string).slice("start:".length);
  assert.equal(line, `axis.runs/1.toolCall: ${tool} (destructive, protected path), 9007199254740991 bytes, SHA-256 0f0f0f0f0f0f0f0f`);
  assert.equal(line.length <= 192, true);
});

test("a size or hash the daemon cannot vouch for is left out of the native detail", () => {
  const content = { bytes: 3, sha256: "0f".repeat(32), head: "", truncated: false, findings: [] };
  const detail = (c: Partial<typeof content>) => runNativeDetail({ tool: "run_command", tier: "destructive", preview: { tier: "destructive", protected: false, content: { ...content, ...c } } });
  for (const bad of [{ bytes: -1 }, { bytes: Number.NaN }, { bytes: 1.5 }, { sha256: "0F".repeat(32) }, { sha256: "0f".repeat(31) }]) {
    assert.equal(detail(bad), "run_command (destructive)", JSON.stringify(bad));
  }
  assert.equal(detail({}), "run_command (destructive), 3 bytes, SHA-256 0f0f0f0f0f0f0f0f");
});
