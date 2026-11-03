// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Delta re-review 2: capability hand-off, failed-handler audit, approvability, and never trusting execute().
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import type { MethodSpec } from "@axis/protocol";
import { ApprovalError, Daemon, DaemonError, MemoryIdempotencyStore, type ContractRegistry } from "../src/index.js";
import { approveAndRun, fakeGate } from "./gate.js";
import { CONTRACT, KEY1, KEY2, req, rig, testMethods, verifier, type Rig } from "./harness.js";

async function ready(t: TestContext, options: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = rig(options);
  t.after(() => r.cleanup());
  await r.handshake();
  return r;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const request = (id: string, payload: Record<string, unknown>, key = KEY1) => req(id, "danger", payload, { idempotencyKey: key });

// ---- D2-S1: the capability reaches the handler, and only the handler ----

test("D2-S1: a capability minted by the adapter inside the approval reaches the handler, hidden from JSON and spreads", async (t) => {
  const secret = Object.freeze({ token: "single-use" });
  const { gate } = fakeGate({ mint: (_i, c) => ({ ...secret, target: c.target }) });
  const r = await ready(t, { gate });
  let seen: { cap: unknown; json: string; keys: string[]; frozen: boolean } | undefined;
  r.daemon.register(CONTRACT, 1, {
    danger: (c) => {
      const a = c.approved as NonNullable<typeof c.approved>;
      seen = { cap: a.capability, json: JSON.stringify(a), keys: Object.keys({ ...a }), frozen: Object.isFrozen(a) };
      return { done: true };
    },
  });
  assert.equal((await r.inbox.response(await approveAndRun(r, "k", { id: "ws-1" }))).ok, true);
  assert.equal((seen?.cap as { token: string }).token, "single-use");
  assert.match((seen?.cap as { target: string }).target, /^request:[0-9a-f]{64}$/, "bound to the approved target");
  assert.ok(!seen?.json.includes("single-use"), "never serialised");
  assert.ok(!seen?.keys.includes("capability"), "not enumerable");
  assert.equal(seen?.frozen, true);
  assert.ok(!JSON.stringify(r.events).includes("single-use"), "never audited");
});
// ---- D2-S2: a failed handler is audited as failed by the approval manager ----

test("D2-S2: a failing handler makes the approval action fail (audited failed) while the client still gets the handler's own error", async (t) => {
  const { gate, calls } = fakeGate();
  const r = await ready(t, { gate });
  let n = 0;
  r.daemon.register(CONTRACT, 1, {
    danger: () => (++n === 1 ? ((): never => { throw new DaemonError("E_NOT_FOUND", "No such workspace"); })() : { done: true }),
  });
  const failed = await r.inbox.response(await approveAndRun(r, "f", { id: "ws-1" }));
  assert.equal(failed.error?.code, "E_NOT_FOUND", "the real mapped error, not E_INTERNAL");
  assert.deepEqual(calls.audit, ["authorised", "completed error"]);
  const ok = await r.inbox.response(await approveAndRun(r, "g", { id: "ws-1" }));
  assert.equal(ok.ok, true);
  assert.deepEqual(calls.audit.slice(2), ["authorised", "completed success"]);
});

// ---- D2-S3: approvability ----

test("D2-S3a: a policy-raised tier on a method that cannot carry an approval is refused before any challenge is issued", async (t) => {
  const { gate, calls } = fakeGate();
  const r = await ready(t, { gate, policy: { evaluate: () => ({ effect: "allow", tier: 3 }) } });
  r.daemon.register(CONTRACT, 1, { echo: () => assert.fail("must not run") });
  r.send(req("n1", "echo", { text: "x" }));
  assert.equal((await r.inbox.response("n1")).error?.code, "E_POLICY_DENIED");
  assert.equal(calls.issue.length, 0, "the user is never prompted for something that can never pass the schema");
  assert.equal(r.events.at(-1)?.payload["reason"], "not_approvable");
});

test("D2-S3b: register() throws for a method that declares tier >= 3 without an optional approval field", () => {
  const base = testMethods["echo"] as MethodSpec;
  const approval = z.strictObject({ challengeId: z.string() });
  const specs: Array<[string, z.ZodType, boolean]> = [
    ["no approval field", z.strictObject({ text: z.string() }), false],
    ["required approval", z.strictObject({ approval }), false],
    ["optional approval", z.strictObject({ approval: approval.optional() }), true],
  ];
  for (const [name, request, ok] of specs) {
    const registry: ContractRegistry = { lookup: () => ({ ...base, request, tier: 3 }), versions: () => [1] };
    const d = new Daemon({ identity: verifier, audit: { append: () => undefined }, registry, idempotency: new MemoryIdempotencyStore() });
    if (ok) assert.doesNotThrow(() => d.register(CONTRACT, 1, { echo: () => 1 }), name);
    else assert.throws(() => d.register(CONTRACT, 1, { echo: () => 1 }), /no optional approval field/, name);
  }
});

// ---- hardening: never trust execute() ----

test("D2-N3: a gate that fires the action without awaiting it cannot put its own value on the wire or free the slot early", async (t) => {
  const { gate } = fakeGate();
  const release: Array<() => void> = [];
  let running = 0;
  let peak = 0;
  const r = await ready(t, {
    limits: { maxInFlight: 1 },
    gate: {
      ...gate,
      execute: (async (_i: unknown, _ref: unknown, _c: unknown, action: (c: object) => Promise<unknown>) => {
        void action({ method: "danger", target: "t", requester: "user" });
        return { ok: true, result: { done: true } };
      }) as never,
    },
  });
  r.daemon.register(CONTRACT, 1, {
    danger: () => new Promise((res) => ((peak = Math.max(peak, ++running)), release.push(() => (running--, res({ done: true }))))),
  });
  const id = await approveAndRun(r, "u", { id: "ws-1" });
  await wait(30);
  r.send(request("second", { id: "ws-2", approval: { challengeId: "B".repeat(43) } }, KEY2));
  assert.equal((await r.inbox.response("second")).error?.code, "E_BACKPRESSURE", "the slot is held while the handler runs");
  release[0]?.();
  const res = await r.inbox.response(id);
  assert.equal(res.error?.code, "E_INTERNAL");
  assert.equal(res.result, undefined);
  assert.equal(peak, 1);
});

test("D2-N3: the action runs at most once, and the wire shows the action's own outcome, not execute's return value", async (t) => {
  const { gate } = fakeGate();
  let runs = 0;
  const r = await ready(t, {
    gate: {
      ...gate,
      execute: (async (_i: unknown, _ref: unknown, _c: unknown, action: (c: object) => Promise<unknown>) => {
        const confirmed = { method: "danger", target: "t", requester: "user" };
        await action(confirmed);
        await action(confirmed).catch(() => undefined);
        return { ok: true, result: { done: "forged" } };
      }) as never,
    },
  });
  r.daemon.register(CONTRACT, 1, { danger: () => (runs++, { done: true }) });
  const res = await r.inbox.response(await approveAndRun(r, "o", { id: "ws-1" }));
  assert.equal(runs, 1);
  assert.deepEqual([res.ok, res.result], [true, { done: true }]);
});

// ---- N5/N6: refusal codes ----

test("D2-N6: an issue() that is out of capacity is E_BACKPRESSURE and an unapprovable request is E_INVALID_ARGUMENT, not E_INTERNAL", async (t) => {
  for (const [code, expected] of [
    ["E_BACKPRESSURE", "E_BACKPRESSURE"],
    ["E_INVALID_ARGUMENT", "E_INVALID_ARGUMENT"],
  ] as const) {
    const { gate } = fakeGate();
    const r = await ready(t, { gate: { ...gate, issue: () => Promise.reject(new ApprovalError(code)) } });
    r.daemon.register(CONTRACT, 1, { danger: () => assert.fail("must not run") });
    r.send(request("i1", { id: "ws-1" }));
    assert.equal((await r.inbox.response("i1")).error?.code, expected);
  }
});

test("D2-N4: an issue() that finishes after the request was cancelled has its challenge withdrawn", async (t) => {
  const { gate, calls } = fakeGate();
  const r = await ready(t, { gate: { ...gate, issue: async (i, c) => (await wait(40), gate.issue(i, c)) } });
  r.daemon.register(CONTRACT, 1, { danger: () => assert.fail("must not run") });
  r.send(request("a1", { id: "ws-1" }));
  await wait(10);
  r.send({ v: 1, cancel: "a1" });
  assert.equal((await r.inbox.response("a1")).error?.code, "E_CANCELLED");
  await wait(80);
  assert.deepEqual(calls.withdraw.map((w) => w.challengeId), ["1".padStart(43, "A")]);
});

test("D2-N2: the first time a window reaches its orphan quota it is reported locally, once", async (t) => {
  const r = await ready(t, { limits: { maxInFlight: 4 }, maxOrphanedPerWindow: 2 });
  r.daemon.register(CONTRACT, 1, { slow: () => new Promise(() => undefined) });
  for (let i = 0; i < 3; i++) r.send(req(`q${i}`, "slow", {}, { timeoutMs: 1 }));
  await wait(60);
  const reports = r.internal.filter((e) => /orphan quota/.test(String((e.error as Error).message)));
  assert.equal(reports.length, 1);
});
