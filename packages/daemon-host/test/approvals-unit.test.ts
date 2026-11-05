// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ChallengeError } from "@axis/challenge";
import { ApprovalError, DaemonError, requestDigest, type ApprovalInput, type HandlerContext } from "@axis/daemon";
import type { Challenge } from "@axis/protocol";
import {
  createApprovals,
  createApprovalsHandlers,
  createChallengeAuditSink,
  NativeBridge,
  nativeSummary,
  PendingRegistry,
  shortenSummary,
  type ApprovalsPort,
  type NativeControl,
} from "../src/index.js";
import { fakeClock } from "./helpers.js";

const CANARY = "canary-secret-text";
const ID = "C".repeat(43);
const DIGEST = "d".repeat(64);
const ctx = (over: Record<string, unknown> = {}, signal = new AbortController().signal): HandlerContext =>
  ({ identity: { actor: "user", windowId: "win-1", connectionId: "c".repeat(22) }, requestId: "r", correlationId: "x", signal, ...over }) as unknown as HandlerContext;
const errorOf = (fn: () => unknown): DaemonError => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof DaemonError, "a DaemonError");
    return e;
  }
  return assert.fail("did not throw");
};
const challenge = (over: Partial<Challenge> = {}): Challenge => ({
  challengeId: ID,
  digest: DIGEST,
  contract: "axis.worktrees",
  method: "remove",
  tier: 4,
  targetSummary: "workspace:ws-1",
  nativeConfirmationRequired: true,
  expiresAt: 1_700_000_060_000,
  ...over,
});

// ---- audit sink ----

test("audit sink: passes the event through, and a throw or a promise is a failed write with fixed text", () => {
  const seen: unknown[] = [];
  const event = { actor: "user", action: "tier4.challenge", target: "t", outcome: "success", payload: { phase: "issued" } } as const;
  createChallengeAuditSink({ append: (e) => void seen.push(e) }).append(event);
  assert.deepEqual(seen, [event]);
  const thrown = errorOf0(() => createChallengeAuditSink({ append: () => { throw new Error(CANARY); } }).append(event));
  assert.ok(!thrown.message.includes(CANARY));
  const promised = errorOf0(() => createChallengeAuditSink({ append: () => Promise.resolve() }).append(event));
  assert.equal(promised.code, "E_INTERNAL");
});
function errorOf0(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (e) {
    return e as { code: string; message: string };
  }
  return assert.fail("did not throw");
}

// ---- pending registry ----

test("shortenSummary: head, ellipsis, tail, on code point boundaries, at most the limit", () => {
  assert.equal(shortenSummary("short"), "short");
  const long = "a".repeat(100) + "\u{1F600}".repeat(200) + "z".repeat(100);
  const out = shortenSummary(long);
  assert.equal(Array.from(out).length, 192);
  assert.ok(out.includes("…") && out.startsWith("a") && out.endsWith("z"));
  assert.ok(!/[\uD800-\uDFFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out), "no lone surrogate");
});

test("registry: lists one window, expires on the monotonic clock, is bounded, forgets by id and by connection", () => {
  const clock = fakeClock();
  const reg = new PendingRegistry({ monotonic: () => clock.monotonic(), ttlMs: 1000, cap: 3 });
  const mk = (n: number): Challenge => challenge({ challengeId: String(n).repeat(30) });
  reg.add(mk(1), "w1", "c1");
  reg.add(mk(2), "w2", "c1");
  reg.add(mk(3), "w1", "c2");
  assert.deepEqual(reg.list("w1").map((c) => c.challengeId), [mk(1).challengeId, mk(3).challengeId]);
  reg.add(mk(4), "w1", "c3");
  assert.equal(reg.size, 3);
  assert.equal(reg.evicted, 1, "the oldest went, never more than the cap");
  reg.removeConnection("c2");
  assert.deepEqual(reg.list("w1").map((c) => c.challengeId), [mk(4).challengeId]);
  reg.remove(mk(4).challengeId);
  assert.deepEqual(reg.list("w1"), []);
  clock.advance(1000);
  assert.deepEqual(reg.list("w2"), []);
  assert.equal(reg.size, 0);
});

test("registry: a summary over the listing limit is shortened; one that cannot be shown is left out", () => {
  const reg = new PendingRegistry({ monotonic: () => 0, ttlMs: 1000, cap: 10 });
  reg.add(challenge({ targetSummary: "x".repeat(500) }), "w", "c");
  const [c] = reg.list("w");
  assert.equal(c?.targetSummary.length, 192);
  reg.add(challenge({ challengeId: "D".repeat(43), targetSummary: "bad‮text" }), "w", "c");
  assert.equal(reg.list("w").length, 1);
});

// ---- native bridge ----

function bridgeRig(maxEntries = 2) {
  const applied: Array<Record<string, unknown>> = [];
  const waits: Array<{ resolve: (v: { confirmed: boolean; proof: string; windowId: string }) => void; reject: (e: Error) => void; signal: AbortSignal | undefined }> = [];
  const control: NativeControl = {
    nativeConfirm: (_req, options) =>
      new Promise((resolve, reject) => {
        waits.push({ resolve, reject, signal: options?.signal });
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  };
  const clock = fakeClock();
  const bridge = new NativeBridge({ control, apply: (a) => void applied.push({ ...a }), monotonic: () => clock.monotonic(), ttlMs: 1000, maxEntries, maxPerWindow: maxEntries });
  const req = (n: number, connectionId = "c1") => ({ challengeId: String(n).repeat(30), proof: "p".repeat(20), windowId: "w1", summary: "s", connectionId, actor: "user" });
  return { bridge, applied, waits, req, clock };
}
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test("bridge: applies the answer with the host's own proof, once, only after the user approved", async () => {
  const { bridge, applied, waits, req } = bridgeRig();
  await bridge.start(req(1));
  waits[0]?.resolve({ confirmed: true, proof: "attacker-proof-value", windowId: "elsewhere" });
  await tick();
  assert.deepEqual(applied, [], "held until the user approves");
  bridge.userApproved(req(1).challengeId);
  bridge.userApproved(req(1).challengeId);
  assert.deepEqual(applied, [{ challengeId: req(1).challengeId, windowId: "w1", proof: "p".repeat(20), confirmed: true }]);
  assert.equal(bridge.stats().entries, 0);
});

test("bridge: a failure is a refusal; a thrown apply is counted, not propagated; end and dispose cancel waits", async () => {
  const { bridge, applied, waits, req } = bridgeRig(3);
  await bridge.start(req(1));
  await bridge.start(req(2));
  bridge.start(req(3, "c2"));
  waits[0]?.reject(Object.assign(new Error(CANARY), { code: "E_TIMEOUT" }));
  await tick();
  bridge.userApproved(req(1).challengeId);
  assert.equal(applied[0]?.["confirmed"], false);
  assert.equal(bridge.stats().failed, 1);
  bridge.end(req(2).challengeId);
  assert.equal(waits[1]?.signal?.aborted, true);
  bridge.endConnection("c2");
  assert.equal(waits[2]?.signal?.aborted, true);
  assert.equal(bridge.stats().entries, 0);
  const bad = new NativeBridge({ control: { nativeConfirm: () => Promise.resolve({ confirmed: true, proof: "p", windowId: "w" }) }, apply: () => { throw new Error(CANARY); }, monotonic: () => 0, ttlMs: 10, maxEntries: 1 });
  await bad.start(req(4));
  bad.userApproved(req(4).challengeId);
  await tick();
  bad.userApproved(req(4).challengeId);
  assert.equal(bad.stats().applyErrors, 1);
  await bridge.start(req(5));
  bridge.dispose();
  assert.equal(waits[3]?.signal?.aborted, true);
  await assert.rejects(bridge.start(req(6)), { code: "E_UNAVAILABLE" });
});

test("bridge: bounded, one wait per challenge, stale entries swept on the monotonic clock", async () => {
  const { bridge, waits, req, clock } = bridgeRig(2);
  await bridge.start(req(1));
  await assert.rejects(bridge.start(req(1)), { code: "E_BACKPRESSURE" });
  await bridge.start(req(2));
  await assert.rejects(bridge.start(req(3)), { code: "E_BACKPRESSURE" });
  clock.advance(1000);
  await bridge.start(req(3));
  assert.equal(bridge.stats().entries, 1);
  assert.equal(waits[0]?.signal?.aborted, true);
});

test("bridge: a nativeConfirm that throws leaves nothing behind", async () => {
  const bridge = new NativeBridge({ control: { nativeConfirm: () => { throw new Error(CANARY); } }, apply: () => undefined, monotonic: () => 0, ttlMs: 10, maxEntries: 1 });
  await assert.rejects(bridge.start({ challengeId: ID, proof: "p".repeat(20), windowId: "w", summary: "s", connectionId: "c", actor: "user" }));
  assert.equal(bridge.stats().entries, 0);
});

// ---- handlers ----

const port = (over: Partial<ApprovalsPort> = {}): ApprovalsPort => ({
  resolve: () => ({ challengeId: ID, state: "approved", nativeRequired: false }),
  pending: () => [],
  ...over,
});
const resolveReq = { challengeId: ID, decision: "approve", digest: DIGEST };

test("handlers: resolve answers in the contract's shape and passes the attested caller, never a payload field", () => {
  let seen: unknown[] = [];
  const h = createApprovalsHandlers({ approvals: port({ resolve: (...a) => ((seen = a), { challengeId: ID, state: "approved", nativeRequired: true }) }) });
  const out = h.resolve(ctx(), resolveReq as never);
  assert.deepEqual(out, { challengeId: ID, state: "approved", nativeRequired: true });
  assert.deepEqual(seen[0], { actor: "user", windowId: "win-1" });
  assert.equal(errorOf(() => h.resolve(ctx(), { ...resolveReq, actor: "user" } as never)).code, "E_INVALID_ARGUMENT");
});

test("handlers: any non-user actor is refused before the manager is touched", () => {
  let calls = 0;
  const h = createApprovalsHandlers({ approvals: port({ resolve: () => (calls++, { challengeId: ID, state: "approved", nativeRequired: false }), pending: () => (calls++, []) }) });
  for (const actor of ["agent:x", "daemon", "system", undefined]) {
    const c = ctx({ identity: { actor, windowId: "win-1" } });
    assert.equal(errorOf(() => h.resolve(c, resolveReq as never)).code, "E_NOT_FOUND");
    assert.equal(errorOf(() => h.pending(c, {} as never)).code, "E_NOT_FOUND");
  }
  assert.equal(calls, 0);
});

test("handlers: manager refusals map to a closed set with fixed text; nothing of the error survives", () => {
  const fail = (e: unknown) => createApprovalsHandlers({ approvals: port({ resolve: () => { throw e; } }) }).resolve;
  const code = (e: unknown) => errorOf(() => fail(e)(ctx(), resolveReq as never));
  const seen = new Set<string>();
  for (const [from, to] of [["E_POLICY_DENIED", "E_NOT_FOUND"], ["E_CONFLICT", "E_CONFLICT"], ["E_INVALID_ARGUMENT", "E_INVALID_ARGUMENT"], ["E_BACKPRESSURE", "E_BACKPRESSURE"], ["E_INTERNAL", "E_INTERNAL"], ["E_NOT_FOUND", "E_INTERNAL"]] as const) {
    const err = code(new ChallengeError(from, `${CANARY} ${ID}`, { state: CANARY }));
    assert.equal(err.code, to);
    assert.ok(!err.message.includes(CANARY) && !err.message.includes(ID) && !JSON.stringify(err.details ?? {}).includes(CANARY));
    seen.add(err.message);
  }
  assert.ok(seen.size >= 4);
  for (const e of [new Error(CANARY), "x", null, { code: "E_POLICY_DENIED" }]) {
    const err = code(e);
    assert.equal(err.code, "E_INTERNAL");
    assert.ok(!err.message.includes(CANARY));
  }
});

test("handlers: an aborted request is E_CANCELLED and the manager is not called; a bad answer is E_INTERNAL", () => {
  let calls = 0;
  const h = createApprovalsHandlers({ approvals: port({ resolve: () => (calls++, { challengeId: "short", state: "approved", nativeRequired: false }), pending: () => (calls++, []) }) });
  const ac = new AbortController();
  ac.abort();
  assert.equal(errorOf(() => h.resolve(ctx({}, ac.signal), resolveReq as never)).code, "E_CANCELLED");
  assert.equal(errorOf(() => h.pending(ctx({}, ac.signal), {} as never)).code, "E_CANCELLED");
  assert.equal(calls, 0);
  assert.equal(errorOf(() => h.resolve(ctx(), resolveReq as never)).code, "E_INTERNAL");
});

test("handlers: pending answers only the caller's window, validates the list, and a bad list is E_INTERNAL", () => {
  let asked = "";
  const h = createApprovalsHandlers({ approvals: port({ pending: (w) => ((asked = w), [{ ...challenge(), targetSummary: "ok" }]) }) });
  assert.deepEqual((h.pending(ctx(), {} as never) as { challenges: Challenge[] }).challenges.length, 1);
  assert.equal(asked, "win-1");
  const dup = createApprovalsHandlers({ approvals: port({ pending: () => [challenge(), challenge()] }) });
  assert.equal(errorOf(() => dup.pending(ctx(), {} as never)).code, "E_INTERNAL");
  const boom = createApprovalsHandlers({ approvals: port({ pending: () => { throw new Error(CANARY); } }) });
  const e = errorOf(() => boom.pending(ctx(), {} as never));
  assert.ok(!e.message.includes(CANARY));
});

// ---- gate adapter, called the way the pipeline calls it ----

const events: Array<{ payload: Record<string, unknown> }> = [];
const sink = { append: (e: { payload: Record<string, unknown> }) => void events.push(e) };
function gateRig(control: NativeControl, extra: Partial<Parameters<typeof createApprovals>[0]> = {}) {
  events.length = 0;
  const clock = fakeClock();
  const approvals = createApprovals({ audit: sink, control, clock, ...extra });
  const input = (over: Partial<ApprovalInput> = {}): ApprovalInput => {
    const args = { id: "ws-1" };
    return {
      identity: { connectionId: "conn-1", windowId: "win-1", actorId: "u", actor: "user", trusted: true, clientKind: "desktop" },
      actor: "user",
      connectionId: "conn-1",
      requestId: "r1",
      correlationId: "x",
      contract: "axis.worktrees",
      contractVersion: 1,
      method: "remove",
      tier: 4,
      args,
      digest: requestDigest("axis.worktrees", 1, "remove", args),
      signal: new AbortController().signal,
      ...over,
    };
  };
  const content = { target: "workspace:ws-1", contentDigest: "e".repeat(64) };
  return { approvals, input, content };
}
const idleControl = (): NativeControl & { waits: AbortSignal[] } => {
  const waits: AbortSignal[] = [];
  return { waits, nativeConfirm: (_r, o) => new Promise(() => void (o?.signal && waits.push(o.signal))) };
};

test("gate: a withdraw or a retry by someone else ends nothing; the requester's withdraw ends the challenge, its listing and its wait", async () => {
  const control = idleControl();
  const { approvals, input, content } = gateRig(control);
  const c = (await approvals.gate.issue(input(), content)) as Challenge;
  assert.equal(approvals.port.pending("win-1").length, 1);
  approvals.gate.withdraw?.(c.challengeId, { actor: "user", connectionId: "conn-2" });
  approvals.gate.withdraw?.(c.challengeId, { actor: "agent:x", connectionId: "conn-1" });
  assert.equal(approvals.stats().withdrawErrors, 2);
  assert.equal(approvals.port.pending("win-1").length, 1);
  assert.equal(control.waits[0]?.aborted, false);
  await assert.rejects(
    approvals.gate.execute(input({ connectionId: "conn-2" }), { challengeId: c.challengeId }, content, () => Promise.reject(new Error("must not run"))),
    (e: unknown) => e instanceof ApprovalError && e.code === "E_POLICY_DENIED" && !e.executed,
  );
  assert.equal(approvals.port.pending("win-1").length, 1, "a bystander's refused retry leaves the listing alone");
  approvals.gate.withdraw?.(c.challengeId, { actor: "user", connectionId: "conn-1" });
  assert.equal(approvals.port.pending("win-1").length, 0);
  assert.equal(control.waits[0]?.aborted, true);
  assert.equal(approvals.stats().native.entries, 0);
  approvals.dispose();
});

test("gate: if the native step cannot start, the challenge is withdrawn, never listed, and the error is opaque", async () => {
  const { approvals, input, content } = gateRig({ nativeConfirm: () => { throw new Error(CANARY); } });
  let thrown: unknown;
  try {
    await approvals.gate.issue(input(), content);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown instanceof Error && !(thrown instanceof ApprovalError));
  assert.ok(!thrown.message.includes(CANARY));
  assert.equal(approvals.port.pending("win-1").length, 0);
  assert.equal(approvals.stats().native.entries, 0);
  assert.deepEqual(events.map((e) => e.payload["phase"]), ["issued", "withdraw"], "the challenge nobody was told about was ended");
  approvals.dispose();
});

test("gate: an action that fails after the spend is thrown as it is (no ApprovalError), and the approval is gone", async () => {
  const { approvals, input, content } = gateRig(idleControl());
  const tier3 = { input: () => input({ tier: 3 }) };
  const c = (await approvals.gate.issue(tier3.input(), content)) as Challenge;
  approvals.port.resolve({ actor: "user", windowId: "win-1" }, { challengeId: c.challengeId, decision: "approve", digest: c.digest });
  await assert.rejects(
    approvals.gate.execute(tier3.input(), { challengeId: c.challengeId }, content, () => Promise.reject(new Error(CANARY))),
    (e: unknown) => e instanceof ChallengeError && e.detail["executed"] === true && !e.message.includes(CANARY),
  );
  await assert.rejects(
    approvals.gate.execute(tier3.input(), { challengeId: c.challengeId }, content, () => Promise.reject(new Error("again"))),
    (e: unknown) => e instanceof ApprovalError && e.code === "E_CONFLICT",
  );
  assert.equal(approvals.port.pending("win-1").length, 0);
  approvals.dispose();
});

test("bridge: a wait that dies for another reason than a timeout is lost and reported once, never a held refusal", async () => {
  const lost: unknown[] = [];
  const waits: Array<(e: Error) => void> = [];
  const bridge = new NativeBridge({
    control: { nativeConfirm: () => new Promise((_r, reject) => void waits.push(reject)) },
    apply: () => assert.fail("nothing to apply"),
    monotonic: () => 0,
    ttlMs: 1000,
    maxEntries: 2,
    onLost: (l) => void lost.push(l),
  });
  const r = { challengeId: ID, proof: "p".repeat(20), windowId: "w", summary: "s", connectionId: "c", actor: "user" };
  await bridge.start(r);
  waits[0]?.(Object.assign(new Error(CANARY), { code: "E_UNAVAILABLE" }));
  await tick();
  assert.deepEqual(lost, [{ challengeId: ID, connectionId: "c", actor: "user" }]);
  assert.equal(bridge.stats().entries, 0);
  assert.equal(bridge.stats().lost, 1);
  // Refused at once: start itself rejects (and onLost is not called, the caller withdraws).
  const instant = new NativeBridge({ control: { nativeConfirm: () => Promise.reject(Object.assign(new Error(CANARY), { code: "E_BACKPRESSURE" })) }, apply: () => undefined, monotonic: () => 0, ttlMs: 1000, maxEntries: 2, onLost: () => assert.fail("not late") });
  await assert.rejects(instant.start(r), (e: unknown) => (e as { code: string }).code === "E_BACKPRESSURE" && !(e as Error).message.includes(CANARY));
  assert.equal(instant.stats().entries, 0);
});

test("bridge: an answered but never approved entry, and its proof, are dropped when it expires", async () => {
  const { bridge, waits, req, clock } = bridgeRig(2);
  await bridge.start(req(1));
  waits[0]?.resolve({ confirmed: true, proof: "p", windowId: "w1" });
  await tick();
  assert.equal(bridge.stats().entries, 1);
  clock.advance(1000);
  assert.equal(bridge.stats().entries, 0);
});

// ---- native summary ----

test("native summary: names the action, keeps it whole, is cut at 192 units, never splits a pair, and falls back from unsafe detail", () => {
  const action = "axis.worktrees/1.remove";
  assert.equal(nativeSummary(action, "workspace:ws-1"), `${action}: workspace:ws-1`);
  assert.equal(nativeSummary(action, "workspace:ws-1", "Project Alpha"), `${action}: Project Alpha`);
  assert.equal(nativeSummary(action, "workspace:ws-1", "bad\u202etext"), `${action}: workspace:ws-1`, "unsafe detail is not shown");
  assert.equal(nativeSummary(action, "workspace:ws-1", ""), `${action}: workspace:ws-1`);
  for (const long of ["x".repeat(900), "\u{1F600}".repeat(400)]) {
    const out = nativeSummary(action, "t", long);
    assert.ok(out.length <= 192 && out.startsWith(`${action}: `) && out.includes("\u2026"));
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out));
  }
});

test("native summary: through the gate the dialog gets the action key, the describe text, and an emoji target fits the contract", async () => {
  const sent: Array<{ summary: string }> = [];
  const control: NativeControl = { nativeConfirm: (r) => (sent.push(r), new Promise(() => undefined)) };
  const { approvals, input, content } = gateRig(control, { describe: () => "Project Alpha" });
  await approvals.gate.issue(input(), content);
  assert.equal(sent[0]?.summary, "axis.worktrees/1.remove: Project Alpha");
  const g2 = gateRig(control, { describe: () => { throw new Error(CANARY); } });
  await g2.approvals.gate.issue(g2.input(), { target: `workspace:${"\u{1F600}".repeat(150)}`, contentDigest: "e".repeat(64) });
  assert.ok((sent[1]?.summary.length ?? 999) <= 192 && sent[1]?.summary.startsWith("axis.worktrees/1.remove: workspace:"));
  const listed = g2.approvals.port.pending("win-1");
  assert.equal(listed.length, 1, "a challenge with an emoji target is still listed in the contract's shape");
  approvals.dispose();
  g2.approvals.dispose();
});

// ---- preflight seam, digest cross-check ----

test("preflight: called with the final tier before any challenge or spend; its error reaches the daemon unchanged; a refused retry keeps the approval", async () => {
  const calls: number[] = [];
  let stalled = true;
  const closed = Object.assign(new Error("stalled"), { code: "E_UNAVAILABLE" });
  const { approvals, input, content } = gateRig(idleControl(), { preflight: (tier) => { calls.push(tier); if (stalled) throw closed; } });
  await assert.rejects(async () => approvals.gate.issue(input({ tier: 3 }), content), (e: unknown) => e === closed);
  assert.deepEqual(calls, [3]);
  assert.deepEqual(events, [], "no challenge, no audit row, no quota used");
  stalled = false;
  const c = (await approvals.gate.issue(input({ tier: 3 }), content)) as Challenge;
  approvals.port.resolve({ actor: "user", windowId: "win-1" }, { challengeId: c.challengeId, decision: "approve", digest: c.digest });
  stalled = true;
  let ran = 0;
  await assert.rejects(approvals.gate.execute(input({ tier: 3 }), { challengeId: c.challengeId }, content, () => (ran++, Promise.resolve(1))), (e: unknown) => e === closed);
  assert.equal(ran, 0);
  assert.deepEqual(calls, [3, 3, 3]);
  stalled = false;
  assert.equal(await approvals.gate.execute(input({ tier: 3 }), { challengeId: c.challengeId }, content, () => (ran++, Promise.resolve(7))), 7);
  assert.equal(ran, 1, "the approval survived the refused retry and is spent once");
  approvals.dispose();
});

test("digest cross-check: a digest that is not the request's is refused at issue and at execute, and the approval is not burned by it", async () => {
  const { approvals, input, content } = gateRig(idleControl());
  await assert.rejects(async () => approvals.gate.issue(input({ tier: 3, digest: "f".repeat(64) }), content), (e: unknown) => e instanceof ApprovalError && e.code === "E_INVALID_ARGUMENT");
  const c = (await approvals.gate.issue(input({ tier: 3 }), content)) as Challenge;
  approvals.port.resolve({ actor: "user", windowId: "win-1" }, { challengeId: c.challengeId, decision: "approve", digest: c.digest });
  await assert.rejects(approvals.gate.execute(input({ tier: 3, digest: "f".repeat(64) }), { challengeId: c.challengeId }, content, () => Promise.resolve(1)), (e: unknown) => e instanceof ApprovalError && e.code === "E_INVALID_ARGUMENT");
  assert.equal(await approvals.gate.execute(input({ tier: 3 }), { challengeId: c.challengeId }, content, () => Promise.resolve(2)), 2);
  approvals.dispose();
});
