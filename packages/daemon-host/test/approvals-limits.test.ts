// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { requestDigest, type ApprovalInput } from "@axis/daemon";
import {
  createApprovals,
  createChallengeAuditLog,
  NativeBridge,
  nativeSummary,
  type NativeControl,
} from "../src/index.js";
import { fakeClock } from "./helpers.js";

const CANARY = "canary-secret-text";
const sink = { append: () => undefined };
const idleControl = (): NativeControl & { waits: AbortSignal[] } => {
  const waits: AbortSignal[] = [];
  return { waits, nativeConfirm: (_r, o) => new Promise(() => void (o?.signal && waits.push(o.signal))) };
};
const events: Array<{ payload: Record<string, unknown> }> = [];
function gateRig(control: NativeControl, extra: Partial<Parameters<typeof createApprovals>[0]> = {}) {
  events.length = 0;
  const approvals = createApprovals({ audit: { append: (e: { payload: Record<string, unknown> }) => void events.push(e) }, control, clock: fakeClock(), ...extra });
  const input = (over: Partial<ApprovalInput> = {}): ApprovalInput => {
    const args = { id: "ws-1" };
    return {
      identity: { connectionId: "conn-1", windowId: "win-1", actorId: "u", actor: "user", trusted: true, clientKind: "desktop" },
      actor: "user", connectionId: "conn-1", requestId: "r1", correlationId: "x", contract: "axis.worktrees", contractVersion: 1,
      method: "remove", tier: 4, args, digest: requestDigest("axis.worktrees", 1, "remove", args), signal: new AbortController().signal, ...over,
    };
  };
  return { approvals, input, content: { target: "workspace:ws-1", contentDigest: "e".repeat(64) } };
}
const bridgeRig = (maxEntries: number) => ({ bridge: new NativeBridge({ control: idleControl(), apply: () => undefined, monotonic: () => 0, ttlMs: 1000, maxEntries, maxPerWindow: maxEntries }), req: (n: number) => ({ challengeId: String(n).repeat(30), proof: "p".repeat(20), windowId: "w1", summary: "s", connectionId: "c1", actor: "user" }) });

test("limits are validated at construction: NaN, Infinity, negative, zero, fractional and huge are refused with fixed text", () => {
  const mk = (extra: Record<string, unknown>) => () => createApprovals({ audit: sink, control: idleControl(), clock: fakeClock(), ...extra } as never);
  for (const bad of [Number.NaN, Infinity, -1, 0, 1.5, 33, 1000, "8"]) {
    for (const key of ["nativeWaitLimit", "nativeWaitPerWindow"]) {
      assert.throws(mk({ [key]: bad }), (e: unknown) => (e as { code: string }).code === "E_INVALID_ARGUMENT" && !(e as Error).message.includes(String(bad)), `${key}=${String(bad)}`);
    }
  }
  assert.throws(mk({ nativeWaitLimit: 4, nativeWaitPerWindow: 5 }), { code: "E_INVALID_ARGUMENT" });
  for (const key of ["challengeTtlMs", "confirmationTtlMs", "maxOutstandingPerActor", "maxOutstandingPerWindow", "maxOutstandingTotal"]) {
    for (const bad of [Number.NaN, Infinity, -1, 0, 1.5]) assert.throws(mk({ limits: { [key]: bad } }), { code: "E_INVALID_ARGUMENT" }, `${key}=${String(bad)}`);
  }
  mk({ nativeWaitLimit: 32, nativeWaitPerWindow: 32 })();
  assert.throws(() => new NativeBridge({ control: idleControl(), apply: () => undefined, monotonic: () => 0, ttlMs: 1, maxEntries: Number.NaN }), { code: "E_INVALID_ARGUMENT" });
});

test("bridge: a reserved place is counted until started or released, per window and in total, and never counted twice", async () => {
  const { bridge, req } = bridgeRig(4);
  const bridge2 = new NativeBridge({ control: idleControl(), apply: () => undefined, monotonic: () => 0, ttlMs: 1000, maxEntries: 4, maxPerWindow: 2 });
  const r1 = bridge2.reserve("w1");
  const r2 = bridge2.reserve("w1");
  assert.ok(r1 && r2);
  assert.equal(bridge2.reserve("w1"), undefined, "the window's share is full");
  const o = bridge2.reserve("w2");
  assert.ok(o);
  r1.release();
  r1.release();
  assert.ok(bridge2.reserve("w1"), "released once, one place back (a second release changes nothing)");
  assert.equal(bridge2.reserve("w1"), undefined);
  await bridge2.start({ ...req(1), windowId: "w2" }, o);
  assert.equal(bridge2.stats().entries, 1);
  assert.ok(bridge2.reserve("w3"), "3 of 4 places used: 2 reserved on w1 and the w2 one, now an entry (counted once)");
  assert.equal(bridge2.reserve("w4"), undefined, "all 4 places used");
  assert.ok(bridge);
});

test("preflight: a function that returns a promise is refused (it could not stop anything)", async () => {
  const { approvals, input, content } = gateRig(idleControl(), { preflight: (() => Promise.reject(new Error(CANARY))) as unknown as (t: number) => void });
  await assert.rejects(async () => approvals.gate.issue(input({ tier: 3 }), content), (e: unknown) => (e as { code?: string }).code === "E_INTERNAL" && !(e as Error).message.includes(CANARY));
  assert.deepEqual(events, []);
  await new Promise((r) => setImmediate(r)); // the dropped rejection must not surface as unhandled
  approvals.dispose();
});

test("native summary: describe text is collapsed, bounded and cannot displace the action; a very long action is cut whole", () => {
  const action = "axis.worktrees/1.remove";
  const spoof = nativeSummary(action, "t", `Alpha\u3000\u3000\u3000   ${"x".repeat(300)}`);
  assert.ok(spoof.startsWith(`${action}: Alpha x`) && spoof.length <= action.length + 2 + 80);
  assert.ok(!/\u3000/.test(spoof));
  const longAction = `axis.${"a".repeat(180)}/1.${"m".repeat(10)}`;
  const out = nativeSummary(longAction, "target");
  assert.ok(out.length <= 192 && out.startsWith("axis.") && !out.includes("target"));
});

test("audit log: the host's factory keeps the method on challenge rows", () => {
  const db = new DatabaseSync(":memory:");
  const log = createChallengeAuditLog(db);
  log.append({ actor: "user", action: "tier4.challenge", target: "sha256:x", outcome: "success", payload: { phase: "issued", method: "remove", ref: "r", tier: 4 } });
  assert.equal((log.list()[0]?.payload as Record<string, unknown>)["method"], "remove");
  db.close();
});
