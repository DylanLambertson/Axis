// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChainHead } from "@axis/audit";
import { DaemonError, requestDigest, type ApprovalInput } from "@axis/daemon";
import type { Challenge } from "@axis/protocol";
import { AnchorManager, anchorPreflight, createApprovals, Disposables, type NativeControl } from "../src/index.js";
import { fakeClock } from "./helpers.js";

const hash = (seq: number): string => seq.toString(16).padStart(64, "0");

function rig() {
  const state = { seq: 0 };
  const events: unknown[] = [];
  const disposables = new Disposables();
  const clock = fakeClock();
  const manager = new AnchorManager({
    clock,
    audit: { head: () => (state.seq === 0 ? null : { seq: state.seq, hash: hash(state.seq) }), checkpoint: () => (state.seq === 0 ? null : { seq: state.seq, hash: hash(state.seq) }) },
    put: () => undefined,
    baseline: null,
    writable: true,
    disposables,
    maxLagEvents: 2,
    maxAgeMs: 60_000,
    coalesceMs: 1,
  });
  const control: NativeControl = { nativeConfirm: () => new Promise(() => undefined) };
  const approvals = createApprovals({ audit: { append: (e) => void events.push(e) }, control, clock, preflight: anchorPreflight(manager) });
  const args = { id: "ws-1" };
  const input: ApprovalInput = {
    identity: { connectionId: "conn-1", windowId: "win-1", actorId: "u", actor: "user", trusted: true, clientKind: "desktop" },
    actor: "user",
    connectionId: "conn-1",
    requestId: "r1",
    correlationId: "x",
    contract: "axis.worktrees",
    contractVersion: 1,
    method: "remove",
    tier: 3,
    args,
    digest: requestDigest("axis.worktrees", 1, "remove", args),
    signal: new AbortController().signal,
  };
  const content = { target: "workspace:ws-1", contentDigest: "e".repeat(64) };
  const stall = (): void => {
    state.seq += 3;
    clock.advance(2);
    manager.noteWrite();
  };
  const resume = (): void => void manager.ack((manager.put as ChainHead).seq);
  return { manager, approvals, input, content, events, stall, resume, dispose: () => (approvals.dispose(), disposables.dispose()) };
}

const unavailable = (e: unknown): boolean => e instanceof DaemonError && e.code === "E_UNAVAILABLE" && e.details?.["reason"] === "anchor_stalled";

test("anchorPreflight throws the guard's closed error from the tier it is given, and nothing below tier 3", () => {
  const r = rig();
  const pre = anchorPreflight(r.manager);
  r.stall();
  for (const tier of [0, 1, 2]) assert.doesNotThrow(() => pre(tier));
  for (const tier of [3, 4, 5]) assert.throws(() => pre(tier), unavailable);
  r.dispose();
});

test("as the gate's preflight: a stalled host issues no challenge and spends no approval, and resumes after the ack", async () => {
  const r = rig();
  r.stall();
  await assert.rejects(async () => r.approvals.gate.issue(r.input, r.content), unavailable);
  assert.deepEqual(r.events, [], "no challenge, no audit row");
  assert.equal(r.approvals.port.pending("win-1").length, 0);
  r.resume();
  const c = (await r.approvals.gate.issue(r.input, r.content)) as Challenge;
  r.approvals.port.resolve({ actor: "user", windowId: "win-1" }, { challengeId: c.challengeId, decision: "approve", digest: c.digest });
  r.stall(); // stalled again between the approval and its use
  let ran = 0;
  await assert.rejects(r.approvals.gate.execute(r.input, { challengeId: c.challengeId }, r.content, () => (ran++, Promise.resolve(1))), unavailable);
  assert.equal(ran, 0, "the action did not run");
  r.resume();
  assert.equal(await r.approvals.gate.execute(r.input, { challengeId: c.challengeId }, r.content, () => (ran++, Promise.resolve(7))), 7);
  assert.equal(ran, 1, "the refused attempt did not spend the approval");
  r.dispose();
});
