// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { errorSchema, type Challenge } from "@axis/protocol";
import { DaemonError, payloadHash, type ApprovalGate, type ApprovalInput } from "../src/index.js";
import { CONTRACT, KEY1, KEY2, req, rig, type Rig } from "./harness.js";

const CHALLENGE: Challenge = {
  challengeId: "A".repeat(43),
  digest: "a".repeat(64),
  contract: "axis.approvals/1",
  method: "danger",
  tier: 4,
  targetSummary: "ws-1",
  nativeConfirmationRequired: true,
  expiresAt: 2_000_000_000_000,
};

async function ready(t: TestContext, options: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = rig(options);
  t.after(() => r.cleanup());
  await r.handshake();
  return r;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- malformed and oversized input ----

test("non-object junk after the handshake gets no response and does not kill the session", async (t) => {
  const r = await ready(t);
  for (const junk of [null, 7, "x", [], [1, 2]]) r.send(junk);
  r.daemon.register(CONTRACT, 1, { echo: (_c, p: { text: string }) => p });
  r.send(req("ok", "echo", { text: "alive" }));
  assert.equal((await r.inbox.response("ok")).ok, true);
});

test("a malformed message that carries an id is answered with E_INVALID_ARGUMENT and the reason, never the content", async (t) => {
  const r = await ready(t);
  r.send({ v: 1, id: "bad1", contract: CONTRACT, method: "echo", payload: { text: "SECRET-CANARY" }, nonsense: true });
  const res = await r.inbox.response("bad1");
  assert.equal(res.error?.code, "E_INVALID_ARGUMENT");
  assert.ok(!JSON.stringify(res).includes("SECRET-CANARY"));
});

test("hostile payload shapes are refused: forbidden keys, depth, size, shared references, non-JSON values", async (t) => {
  const r = await ready(t);
  const shared = { a: 1 };
  const deep = (() => {
    let o: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 40; i++) o = { n: o };
    return o;
  })();
  const cases: Array<[string, unknown]> = [
    ["proto", JSON.parse('{"text":"x","__proto__":{"polluted":true}}')],
    ["ctor", JSON.parse('{"text":"x","constructor":{"x":1}}')],
    ["deep", deep],
    ["big", { text: "x".repeat(300_000) }],
    ["shared", { a: shared, b: shared }],
    ["date", { text: new Date() }],
  ];
  for (const [id, payload] of cases) {
    r.send(req(id, "echo", payload));
    const res = await r.inbox.response(id);
    assert.equal(res.error?.code, "E_INVALID_ARGUMENT", id);
  }
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
});

test("flooding invalid messages closes the connection", async (t) => {
  const r = await ready(t, { limits: { maxViolations: 5 } });
  for (let i = 0; i < 20; i++) r.send({ garbage: i });
  assert.ok(await r.inbox.closedWithin());
});

// ---- tier enforcement and policy ----

test("with no policy configured everything is denied (default deny) and audited without the payload", async (t) => {
  const r = await ready(t, { noPolicy: true });
  r.daemon.register(CONTRACT, 1, { echo: () => assert.fail("must not run") });
  r.send(req("d1", "echo", { text: "PAYLOAD-CANARY" }));
  assert.equal((await r.inbox.response("d1")).error?.code, "E_POLICY_DENIED");
  assert.equal(r.events[0]?.outcome, "denied");
  assert.ok(!JSON.stringify(r.events).includes("PAYLOAD-CANARY"));
});

test("a policy deny stops the handler; the audit event has tier, method and outcome only", async (t) => {
  const r = await ready(t, { policy: { evaluate: () => ({ effect: "deny" }) } });
  r.daemon.register(CONTRACT, 1, { echo: () => assert.fail("must not run") });
  r.send(req("d2", "echo", { text: "x" }));
  assert.equal((await r.inbox.response("d2")).error?.code, "E_POLICY_DENIED");
  assert.deepEqual(r.events[0], {
    actor: "user",
    action: "policy.decision",
    target: `${CONTRACT}/echo`,
    outcome: "denied",
    payload: { tier: 0, sideEffect: "read", connectionId: "conn-1", decision: "deny" },
  });
});

test("tier 3 and above need an approval gate: absent gate fails closed, a policy can raise but never lower the tier", async (t) => {
  const noGate = await ready(t);
  noGate.daemon.register(CONTRACT, 1, { danger: () => assert.fail("must not run") });
  noGate.send(req("t1", "danger", { id: "ws-1" }, { idempotencyKey: KEY1 }));
  assert.equal((await noGate.inbox.response("t1")).error?.code, "E_POLICY_DENIED");

  const lowering = await ready(t, { policy: { evaluate: () => ({ effect: "allow", tier: 0 }) } });
  lowering.daemon.register(CONTRACT, 1, { danger: () => assert.fail("must not run") });
  lowering.send(req("t2", "danger", { id: "ws-1" }, { idempotencyKey: KEY1 }));
  assert.equal((await lowering.inbox.response("t2")).error?.code, "E_POLICY_DENIED", "tier stayed 4");

  const raising = await ready(t, { policy: { evaluate: () => ({ effect: "allow", tier: 3 }) } });
  raising.daemon.register(CONTRACT, 1, { echo: () => assert.fail("must not run") });
  raising.send(req("t3", "echo", { text: "x" }));
  assert.equal((await raising.inbox.response("t3")).error?.code, "E_POLICY_DENIED", "a raised tier also needs a gate");
});

test("tier 4 without a valid confirmation returns E_APPROVAL_REQUIRED carrying a schema-valid challenge", async (t) => {
  const inputs: ApprovalInput[] = [];
  const gate: ApprovalGate = { check: (i) => (inputs.push(i), { status: "required", challenge: CHALLENGE }) };
  const r = await ready(t, { gate });
  r.daemon.register(CONTRACT, 1, { danger: () => assert.fail("must not run") });
  r.send(req("a1", "danger", { id: "ws-1" }, { idempotencyKey: KEY1 }));
  const res = await r.inbox.response("a1");
  assert.equal(res.error?.code, "E_APPROVAL_REQUIRED");
  assert.doesNotThrow(() => errorSchema.parse(res.error));
  assert.deepEqual((res.error?.details as { challenge: Challenge }).challenge, CHALLENGE);
  assert.equal(inputs[0]?.tier, 4);
  assert.equal(inputs[0]?.identity.actor, "user");
  assert.equal(inputs[0]?.payloadHash, payloadHash({ id: "ws-1" }));
  assert.equal(r.events.at(-1)?.outcome, "denied");
});

test("a confirmed gate result reaches the handler as ctx.confirmation, and the approval reference is passed to the gate", async (t) => {
  const token = Object.freeze({ kind: "token" });
  const seen: ApprovalInput[] = [];
  const gate: ApprovalGate = { check: (i) => (seen.push(i), { status: "confirmed", confirmation: token }) };
  const r = await ready(t, { gate });
  let got: unknown;
  r.daemon.register(CONTRACT, 1, { danger: (c) => ((got = c.confirmation), { done: true }) });
  r.send(req("a2", "danger", { id: "ws-1", approval: { challengeId: "B".repeat(43) } }, { idempotencyKey: KEY1 }));
  assert.equal((await r.inbox.response("a2")).ok, true);
  assert.equal(got, token);
  assert.deepEqual(seen[0]?.approval, { challengeId: "B".repeat(43) });
  assert.equal(seen[0]?.idempotencyKey, KEY1);
});

test("a gate that denies is E_POLICY_DENIED", async (t) => {
  const r = await ready(t, { gate: { check: () => ({ status: "denied" }) } });
  r.daemon.register(CONTRACT, 1, { danger: () => assert.fail("must not run") });
  r.send(req("a3", "danger", { id: "ws-1" }, { idempotencyKey: KEY1 }));
  assert.equal((await r.inbox.response("a3")).error?.code, "E_POLICY_DENIED");
});

// ---- idempotency ----

test("a method that requires a key refuses a request without one", async (t) => {
  const r = await ready(t);
  r.daemon.register(CONTRACT, 1, { write: () => assert.fail("must not run") });
  r.send(req("k0", "write", { n: 1 }));
  assert.equal((await r.inbox.response("k0")).error?.code, "E_INVALID_ARGUMENT");
});

test("replay: the same key and payload runs the handler once and returns the stored result", async (t) => {
  const r = await ready(t);
  let runs = 0;
  r.daemon.register(CONTRACT, 1, { write: (_c, p: { n: number }) => (runs++, { n: p.n + runs }) });
  r.send(req("r1", "write", { n: 10 }, { idempotencyKey: KEY1 }));
  const first = await r.inbox.response("r1");
  r.send(req("r2", "write", { n: 10 }, { idempotencyKey: KEY1 }));
  const second = await r.inbox.response("r2");
  assert.equal(runs, 1);
  assert.deepEqual(first.result, { n: 11 });
  assert.deepEqual(second.result, { n: 11 });
  assert.equal(r.events.filter((e) => e.action === "rpc.execute").length, 1, "only the real execution is an execution event");
});

test("the same key with a different payload is E_IDEMPOTENCY_CONFLICT; another actor's key is independent", async (t) => {
  const r = await ready(t);
  let runs = 0;
  r.daemon.register(CONTRACT, 1, { write: (_c, p: { n: number }) => (runs++, p) });
  r.send(req("c1", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  await r.inbox.response("c1");
  r.send(req("c2", "write", { n: 2 }, { idempotencyKey: KEY1 }));
  assert.equal((await r.inbox.response("c2")).error?.code, "E_IDEMPOTENCY_CONFLICT");

  const other = r.connect("good:actor-2");
  other.client.postMessage({ type: "hello", protocolVersions: [1], contracts: [{ id: CONTRACT, versions: [1] }] });
  await other.inbox.until((m): m is object => typeof m === "object" && m !== null && (m as { type?: string }).type === "welcome");
  other.client.postMessage(req("c3", "write", { n: 2 }, { idempotencyKey: KEY1 }));
  assert.equal((await other.inbox.response("c3")).ok, true);
  assert.equal(runs, 2);
});

test("a failed call frees its key so a bounded retry can run; a concurrent call with the same key is refused", async (t) => {
  const r = await ready(t);
  let runs = 0;
  let release: () => void = () => undefined;
  r.daemon.register(CONTRACT, 1, {
    write: async (_c, p: { n: number }) => {
      runs++;
      if (runs === 1) throw new DaemonError("E_UNAVAILABLE", "try again");
      if (runs === 2) await new Promise<void>((res) => (release = res));
      return p;
    },
  });
  r.send(req("f1", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  assert.equal((await r.inbox.response("f1")).error?.code, "E_UNAVAILABLE");
  r.send(req("f2", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  await wait(30);
  r.send(req("f3", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  assert.equal((await r.inbox.response("f3")).error?.code, "E_CONFLICT");
  release();
  assert.equal((await r.inbox.response("f2")).ok, true);
});

test("an optional-idempotency method replays only when a key is given; a method with none ignores the key", async (t) => {
  const r = await ready(t);
  let runs = 0;
  r.daemon.register(CONTRACT, 1, { optional: (_c, p: { n: number }) => (runs++, p), echo: (_c, p: { text: string }) => (runs++, p) });
  r.send(req("o1", "optional", { n: 1 }));
  r.send(req("o2", "optional", { n: 1 }));
  await r.inbox.response("o1");
  await r.inbox.response("o2");
  assert.equal(runs, 2);
  r.send(req("o3", "echo", { text: "a" }, { idempotencyKey: KEY2 }));
  r.send(req("o4", "echo", { text: "a" }, { idempotencyKey: KEY2 }));
  await r.inbox.response("o3");
  await r.inbox.response("o4");
  assert.equal(runs, 4);
});

test("the approval field is excluded from the payload hash, so a retry with a challenge still matches", () => {
  assert.equal(payloadHash({ id: "a", approval: { challengeId: "X".repeat(30) } }), payloadHash({ id: "a" }));
  assert.notEqual(payloadHash({ id: "a" }), payloadHash({ id: "b" }));
  assert.equal(payloadHash({ b: 1, a: 2 }), payloadHash({ a: 2, b: 1 }));
});

// ---- cancel, timeout, close ----

test("cancel answers E_CANCELLED once, aborts the handler's signal, and a late result is dropped", async (t) => {
  const r = await ready(t);
  let aborted = false;
  r.daemon.register(CONTRACT, 1, {
    slow: (c) =>
      new Promise((resolve) => {
        c.signal.addEventListener("abort", () => {
          aborted = true;
          setTimeout(() => resolve({}), 10);
        });
      }),
  });
  r.send(req("x1", "slow"));
  await wait(20);
  r.send({ v: 1, cancel: "x1" });
  assert.equal((await r.inbox.response("x1")).error?.code, "E_CANCELLED");
  await wait(40);
  assert.ok(aborted);
  assert.equal(r.inbox.all.filter((m) => (m as { id?: string }).id === "x1").length, 1);
});

test("cancelling an unknown or finished id is ignored", async (t) => {
  const r = await ready(t);
  r.daemon.register(CONTRACT, 1, { echo: (_c, p: { text: string }) => p });
  r.send({ v: 1, cancel: "never-existed" });
  r.send(req("y1", "echo", { text: "x" }));
  await r.inbox.response("y1");
  r.send({ v: 1, cancel: "y1" });
  r.send(req("y2", "echo", { text: "x" }));
  assert.equal((await r.inbox.response("y2")).ok, true);
});

test("the server enforces the smaller of the method ceiling and the client's timeout; the client cannot raise it", async (t) => {
  const r = await ready(t);
  const signals: AbortSignal[] = [];
  r.daemon.register(CONTRACT, 1, { slow: (c) => (signals.push(c.signal), new Promise(() => undefined)) });
  const t0 = Date.now();
  r.send(req("m1", "slow", {}, { timeoutMs: 20 }));
  assert.equal((await r.inbox.response("m1")).error?.code, "E_TIMEOUT");
  assert.ok(Date.now() - t0 < 100, "client's lower timeout applied");
  const t1 = Date.now();
  r.send(req("m2", "slow", {}, { timeoutMs: 30_000 }));
  assert.equal((await r.inbox.response("m2")).error?.code, "E_TIMEOUT");
  const took = Date.now() - t1;
  assert.ok(took >= 100 && took < 1000, `method ceiling (120 ms) applied, took ${took}`);
  assert.ok(signals.every((s) => s.aborted));
});

test("closing the connection aborts in-flight handlers and sends nothing", async (t) => {
  const r = await ready(t);
  let signal: AbortSignal | undefined;
  r.daemon.register(CONTRACT, 1, { slow: (c) => ((signal = c.signal), new Promise(() => undefined)) });
  r.send(req("z1", "slow"));
  await wait(20);
  r.client.close();
  await wait(50);
  assert.equal(signal?.aborted, true);
  assert.equal(r.daemon.connectionCount, 0);
});

// ---- backpressure ----

test("more than maxInFlight concurrent requests get E_BACKPRESSURE; a reused in-flight id is refused", async (t) => {
  const r = await ready(t, { limits: { maxInFlight: 2 } });
  r.daemon.register(CONTRACT, 1, { slow: () => new Promise((res) => setTimeout(() => res({}), 60)) });
  r.send(req("b1", "slow"));
  r.send(req("b2", "slow"));
  r.send(req("b3", "slow"));
  assert.equal((await r.inbox.response("b3")).error?.code, "E_BACKPRESSURE");
  r.send(req("b1", "slow"));
  await r.inbox.until((m): m is object => (m as { id?: string }).id === "b1" && (m as { error?: { code: string } }).error?.code === "E_CONFLICT");
  assert.equal((await r.inbox.response("b2")).ok, true);
});

test("the per-connection message rate is bounded", async (t) => {
  const r = await ready(t, { limits: { maxMessagesPerSecond: 1, burst: 5, maxViolations: 1000 } });
  r.daemon.register(CONTRACT, 1, { echo: (_c, p: { text: string }) => p });
  for (let i = 0; i < 30; i++) r.send(req(`rl${i}`, "echo", { text: "x" }));
  await wait(150);
  const answered = r.inbox.all.filter((m) => (m as { id?: string }).id?.startsWith("rl"));
  const limited = answered.filter((m) => (m as { error?: { code: string } }).error?.code === "E_BACKPRESSURE");
  assert.ok(limited.length >= 20, `expected most messages limited, got ${limited.length}`);
  assert.ok(answered.filter((m) => (m as { ok?: boolean }).ok).length <= 6);
});

// ---- error sanitisation ----

test("unexpected throws become a bare E_INTERNAL: no message, no stack, no echo; the raw error stays local", async (t) => {
  const r = await ready(t);
  r.daemon.register(CONTRACT, 1, {
    boom: () => {
      throw new Error("db password is hunter2 at /Users/x/secret.ts");
    },
  });
  r.send(req("s1", "boom"));
  const res = await r.inbox.response("s1");
  assert.equal(res.error?.code, "E_INTERNAL");
  assert.equal(res.error?.message, "Internal error");
  const wire = JSON.stringify(res);
  for (const leak of ["hunter2", "/Users/x", "secret.ts", "at ", "stack"]) assert.ok(!wire.includes(leak), leak);
  assert.equal(r.internal.length, 1);
  assert.match(String((r.internal[0]?.error as Error).message), /hunter2/);
  assert.equal(r.internal[0]?.correlationId, res.error && (res.error as { correlationId?: string }).correlationId);
});

test("non-Error throws and objects that merely look like wire errors are not trusted", async (t) => {
  const r = await ready(t);
  let n = 0;
  const throwers = [() => { throw "plain string secret"; }, () => { throw { code: "E_POLICY_DENIED", message: "forged" }; }, () => { throw null; }];
  r.daemon.register(CONTRACT, 1, { boom: () => throwers[n++ % 3]?.() });
  for (let i = 0; i < 3; i++) {
    r.send(req(`n${i}`, "boom"));
    const res = await r.inbox.response(`n${i}`);
    assert.equal(res.error?.code, "E_INTERNAL");
    assert.ok(!JSON.stringify(res).includes("secret"));
  }
});

test("a DaemonError carries its code and user-safe message; one that cannot be valid on the wire is replaced", async (t) => {
  const r = await ready(t);
  let n = 0;
  r.daemon.register(CONTRACT, 1, {
    boom: () => {
      if (n++ === 0) throw new DaemonError("E_NOT_FOUND", "No such workspace", { id: "ws-9" });
      throw new DaemonError("E_APPROVAL_REQUIRED", "needs a challenge it does not have");
    },
  });
  r.send(req("de1", "boom"));
  const a = await r.inbox.response("de1");
  assert.deepEqual([a.error?.code, a.error?.message, a.error?.details], ["E_NOT_FOUND", "No such workspace", { id: "ws-9" }]);
  r.send(req("de2", "boom"));
  assert.equal((await r.inbox.response("de2")).error?.code, "E_INTERNAL");
});

test("a handler response that does not match the contract (extra fields) is never sent", async (t) => {
  const r = await ready(t);
  r.daemon.register(CONTRACT, 1, { leaky: () => ({ ok: true, apiKey: "LEAK-CANARY" }) });
  r.send(req("l1", "leaky"));
  const res = await r.inbox.response("l1");
  assert.equal(res.error?.code, "E_INTERNAL");
  assert.ok(!JSON.stringify(res).includes("LEAK-CANARY"));
});

test("a known method without a handler is E_UNAVAILABLE; registering a method the registry lacks throws", async (t) => {
  const r = await ready(t);
  r.send(req("h1", "unhandled"));
  assert.equal((await r.inbox.response("h1")).error?.code, "E_UNAVAILABLE");
  assert.throws(() => r.daemon.register(CONTRACT, 1, { nosuch: () => 1 }), /No such method/);
  r.daemon.register(CONTRACT, 1, { echo: () => 1 });
  assert.throws(() => r.daemon.register(CONTRACT, 1, { echo: () => 1 }), /already registered/);
});

// ---- audit ----

test("side-effecting calls are audited at decision and completion; reads only at decision; payloads never", async (t) => {
  const r = await ready(t);
  r.daemon.register(CONTRACT, 1, { write: (_c, p: { n: number }) => p, echo: (_c, p: { text: string }) => p });
  r.send(req("au1", "write", { n: 777777 }, { idempotencyKey: KEY1 }));
  await r.inbox.response("au1");
  r.send(req("au2", "echo", { text: "CANARY-TEXT" }));
  await r.inbox.response("au2");
  assert.deepEqual(
    r.events.map((e) => [e.action, e.target, e.outcome]),
    [
      ["policy.decision", `${CONTRACT}/write`, "success"],
      ["rpc.execute", `${CONTRACT}/write`, "success"],
      ["policy.decision", `${CONTRACT}/echo`, "success"],
    ],
  );
  const dump = JSON.stringify(r.events);
  assert.ok(!dump.includes("777777") && !dump.includes("CANARY-TEXT") && !dump.includes(KEY1));
});

test("fail closed: if the audit sink throws at the decision, the handler does not run", async (t) => {
  const r = await ready(t, { audit: { append: () => { throw new Error("sink down"); } } });
  r.daemon.register(CONTRACT, 1, { echo: () => assert.fail("must not run") });
  r.send(req("fc1", "echo", { text: "x" }));
  const res = await r.inbox.response("fc1");
  assert.equal(res.error?.code, "E_INTERNAL");
  assert.ok(!JSON.stringify(res).includes("sink down"));
});

test("a failing handler is audited as an error execution with its code, not its message", async (t) => {
  const r = await ready(t);
  r.daemon.register(CONTRACT, 1, { write: () => { throw new DaemonError("E_CONFLICT", "dirty"); } });
  r.send(req("fe1", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  await r.inbox.response("fe1");
  const last = r.events.at(-1);
  assert.equal(last?.action, "rpc.execute");
  assert.equal(last?.outcome, "error");
  assert.equal(last?.payload["code"], "E_CONFLICT");
});
