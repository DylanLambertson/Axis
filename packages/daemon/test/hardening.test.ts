// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for review findings B2, S1, S5, S6 and the nits.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { MethodSpec } from "@axis/protocol";
import {
  Daemon,
  DaemonError,
  MemoryIdempotencyStore,
  SAFE_MESSAGE_MAX,
  canonicalJson,
  fromElectronPort,
  requestDigest,
  type ApprovalInput,
  type ContractRegistry,
  type ElectronPortLike,
} from "../src/index.js";
import { CONTRACT, KEY1, cid, identityOf, req, rig, testRegistry, verifier, type Rig } from "./harness.js";

async function ready(t: TestContext, options: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = rig(options);
  t.after(() => r.cleanup());
  await r.handshake();
  return r;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- B2: policy decisions and tiers are validated ----

const BAD_DECISIONS: Array<[string, unknown]> = [
  ["NaN tier", { effect: "allow", tier: Number.NaN }],
  ["Infinity tier", { effect: "allow", tier: Number.POSITIVE_INFINITY }],
  ["negative tier", { effect: "allow", tier: -1 }],
  ["fractional tier", { effect: "allow", tier: 1.5 }],
  ["tier above 5", { effect: "allow", tier: 6 }],
  ["string tier", { effect: "allow", tier: "4" }],
  ["missing effect", { tier: 4 }],
  ["unknown effect", { effect: "maybe" }],
  ["extra field", { effect: "allow", tier: 1, sneaky: true }],
  ["null", null],
  ["undefined", undefined],
];

for (const [name, decision] of BAD_DECISIONS) {
  test(`B2: an invalid policy decision (${name}) is a deny, audited, and never reaches the handler`, async (t) => {
    const r = await ready(t, { policy: { evaluate: () => decision as never } });
    r.daemon.register(CONTRACT, 1, { danger: () => assert.fail("must not run") });
    r.send(req("b2", "danger", { id: "ws-1" }, { idempotencyKey: KEY1 }));
    assert.equal((await r.inbox.response("b2")).error?.code, "E_POLICY_DENIED");
    assert.equal(r.events[0]?.outcome, "denied");
    assert.equal(r.events[0]?.payload["reason"], "invalid_policy_decision");
  });
}

test("B2: a NaN tier with no approval gate configured cannot run a tier 4 destructive handler", async (t) => {
  const r = await ready(t, { policy: { evaluate: () => ({ effect: "allow", tier: Number.NaN }) } });
  let ran = false;
  r.daemon.register(CONTRACT, 1, { danger: () => ((ran = true), { done: true }) });
  r.send(req("nan1", "danger", { id: "ws-1" }, { idempotencyKey: KEY1 }));
  assert.notEqual((await r.inbox.response("nan1")).ok, true);
  assert.equal(ran, false);
});

test("B2: a policy that throws fails the request closed with an audit event", async (t) => {
  const r = await ready(t, { policy: { evaluate: () => { throw new Error("rule bug"); } } });
  r.daemon.register(CONTRACT, 1, { echo: () => assert.fail("must not run") });
  r.send(req("pe", "echo", { text: "x" }));
  assert.equal((await r.inbox.response("pe")).error?.code, "E_INTERNAL");
  assert.equal(r.events[0]?.outcome, "error");
  assert.equal(r.events[0]?.payload["reason"], "policy_error");
});

test("B2: register() rejects a method spec whose tier is not 0..5", () => {
  const spec = (tier: unknown): MethodSpec => ({ ...(testRegistry.lookup(CONTRACT, 1, "echo") as MethodSpec), tier: tier as never });
  for (const tier of [Number.NaN, Number.POSITIVE_INFINITY, -1, 6, 1.5, "3", undefined]) {
    const registry: ContractRegistry = { lookup: () => spec(tier), versions: () => [1] };
    const d = new Daemon({ identity: verifier, audit: { append: () => undefined }, registry, idempotency: new MemoryIdempotencyStore() });
    assert.throws(() => d.register(CONTRACT, 1, { echo: () => 1 }), /Invalid tier/, String(tier));
  }
});

test("B2: a registry whose spec turns invalid after registration is refused at request time", async (t) => {
  let bad = false;
  const registry: ContractRegistry = {
    versions: testRegistry.versions,
    lookup: (c, v, m) => {
      const s = testRegistry.lookup(c, v, m);
      return s && bad ? ({ ...s, tier: Number.NaN } as MethodSpec) : s;
    },
  };
  const r = await ready(t, { registry });
  r.daemon.register(CONTRACT, 1, { echo: () => assert.fail("must not run") });
  bad = true;
  r.send(req("bt", "echo", { text: "x" }));
  assert.equal((await r.inbox.response("bt")).error?.code, "E_INTERNAL");
});

// ---- S1: one request digest, shared with @axis/challenge ----

const ARGS = { id: "ws-1", deleteBranch: false };
// Vectors computed independently of the implementation (sha256 of the exact JSON text).
const VECTORS: Array<[string, [string, number, string, unknown], string]> = [
  [
    '["axis.request/1","axis.worktrees/1",1,"remove","{\\"deleteBranch\\":false,\\"id\\":\\"ws-1\\"}"]',
    ["axis.worktrees/1", 1, "remove", ARGS],
    "ccb3a71aa0bc5bd6db5ccfe6fe9a09abef12092dce13ba4f6d99e929a30e0fd7",
  ],
  [
    '["axis.request/1","c",1,"m","{\\"a\\":\\"x\\",\\"b\\":[1,{\\"y\\":true,\\"z\\":null}]}"]',
    ["c", 1, "m", { b: [1, { z: null, y: true }], a: "x" }],
    "de8399306f850ad7498d82c8f95ec94ca317181b2422480425c52ad8ed55e596",
  ],
  [
    '["axis.request/1","axis.worktrees",1,"remove","{\\"deleteBranch\\":false,\\"id\\":\\"ws-1\\"}"]',
    ["axis.worktrees", 1, "remove", ARGS],
    "adb7a157e75395816cf74974fbdfa2b5bdf32831996a578ff80cdb46fe9d2735",
  ],
];

test("S1: requestDigest matches the fixed vectors shared with @axis/challenge", () => {
  for (const [, [contract, version, method, payload], hex] of VECTORS) {
    assert.equal(requestDigest(contract, version, method, payload as never), hex);
  }
});

test("S1: the digest ignores the approval field, changes with every other input and has no delimiter ambiguity", () => {
  const base = requestDigest("c", 1, "m", { a: 1 });
  assert.equal(requestDigest("c", 1, "m", { a: 1, approval: { challengeId: "x".repeat(30) } }), base);
  assert.notEqual(requestDigest("d", 1, "m", { a: 1 }), base);
  assert.notEqual(requestDigest("c", 2, "m", { a: 1 }), base);
  assert.notEqual(requestDigest("c", 1, "n", { a: 1 }), base);
  assert.notEqual(requestDigest("c", 1, "m", { a: 2 }), base);
  assert.notEqual(requestDigest("a", 1, "b", {}), requestDigest("", 1, 'a","b', {}));
  assert.equal(canonicalJson({ "10": 1, "2": 2, b: [{ z: 1, a: 2 }] }), '{"10":1,"2":2,"b":[{"a":2,"z":1}]}');
});

test("S1: the gate receives the daemon's digest, the attested actor and connection, and an AbortSignal", async (t) => {
  const seen: ApprovalInput[] = [];
  const r = await ready(t, { gate: { check: (i) => (seen.push(i), { status: "denied" }) } });
  r.daemon.register(CONTRACT, 1, { danger: () => assert.fail("must not run") });
  r.send(req("d1", "danger", { id: "ws-1", approval: { challengeId: "A".repeat(43) } }, { idempotencyKey: KEY1 }));
  await r.inbox.response("d1");
  const input = seen[0] as ApprovalInput;
  assert.equal(input.digest, requestDigest(CONTRACT, 1, "danger", { id: "ws-1" }));
  assert.equal(input.contract, CONTRACT, "the bare contract id");
  assert.equal(input.contractVersion, 1);
  assert.equal(input.actor, "user");
  assert.equal(input.connectionId, cid("conn-1"));
  assert.ok(input.signal instanceof AbortSignal);
});

// ---- S5: audit ----

test("S5a: an async sink that rejects at the decision fails closed, with no unhandled rejection", async (t) => {
  const unhandled: unknown[] = [];
  const on = (e: unknown): number => unhandled.push(e);
  process.on("unhandledRejection", on);
  t.after(() => void process.off("unhandledRejection", on));
  const r = await ready(t, { audit: { append: () => Promise.reject(new Error("sink down")) } });
  r.daemon.register(CONTRACT, 1, { echo: () => assert.fail("must not run") });
  r.send(req("as", "echo", { text: "x" }));
  assert.equal((await r.inbox.response("as")).error?.code, "E_INTERNAL");
  await wait(30);
  assert.deepEqual(unhandled, []);
  assert.ok(r.internal.length >= 1, "reported locally");
});

test("S5b: an async sink that rejects at completion is reported locally and does not change the answer", async (t) => {
  let n = 0;
  const r = await ready(t, { audit: { append: () => (++n === 1 ? undefined : Promise.reject(new Error("late"))) } });
  r.daemon.register(CONTRACT, 1, { write: (_c, p: { n: number }) => p });
  r.send(req("ac", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  assert.equal((await r.inbox.response("ac")).ok, true);
  assert.equal(r.internal.length, 1);
});

test("S5c: events carry the D5 fields: correlationId, workspaceId and the contract version", async (t) => {
  const r = rig({ attestation: "good@ws-9" });
  t.after(() => r.cleanup());
  await r.handshake();
  r.daemon.register(CONTRACT, 1, { write: (_c, p: { n: number }) => p });
  r.send(req("df", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  await r.inbox.response("df");
  assert.equal(r.events.length, 2);
  for (const e of r.events) {
    assert.equal(e.target, `${CONTRACT}/1.write`);
    assert.equal(e.payload["workspaceId"], "ws-9");
    assert.equal(e.payload["contractVersion"], 1);
    assert.match(String(e.payload["correlationId"]), /^[0-9a-f]{16}$/);
  }
  assert.equal(r.events[0]?.payload["correlationId"], r.events[1]?.payload["correlationId"]);
});

test("S5d: a side-effecting handler that throws after the abort still produces an rpc.execute event", async (t) => {
  const r = await ready(t);
  r.daemon.register(CONTRACT, 1, {
    write: (c) => new Promise((_, reject) => c.signal.addEventListener("abort", () => reject(new Error("half done")))),
  });
  r.send(req("ab", "write", { n: 1 }, { idempotencyKey: KEY1, timeoutMs: 10 }));
  assert.equal((await r.inbox.response("ab")).error?.code, "E_TIMEOUT");
  await wait(30);
  const exec = r.events.filter((e) => e.action === "rpc.execute");
  assert.equal(exec.length, 1);
  assert.equal(exec[0]?.outcome, "failure");
  assert.equal(exec[0]?.payload["result"], "aborted");
});

// ---- S6: handler errors are constrained ----

async function thrown(t: TestContext, error: unknown): Promise<{ code?: string; message?: string; details?: Record<string, unknown> }> {
  const r = await ready(t);
  r.daemon.register(CONTRACT, 1, { boom: () => { throw error; } });
  r.send(req("s6", "boom"));
  return (await r.inbox.response("s6")).error ?? {};
}

test("S6: a handler cannot mint E_APPROVAL_REQUIRED, even with a schema-valid challenge", async (t) => {
  const challenge = {
    challengeId: "A".repeat(43),
    digest: "a".repeat(64),
    contract: "axis.approvals/1",
    method: "danger",
    tier: 4,
    targetSummary: "x",
    nativeConfirmationRequired: true,
    expiresAt: 2_000_000_000_000,
  };
  const e = await thrown(t, new DaemonError("E_APPROVAL_REQUIRED", "Confirmation required", { challenge: challenge as never }));
  assert.equal(e.code, "E_INTERNAL");
  assert.equal(e.details, undefined);
});

test("S6: an unsafe message (too long, control characters, secret-shaped) is replaced by the generic one", async (t) => {
  const unsafe = [
    "x ".repeat(SAFE_MESSAGE_MAX),
    "line one\nline two",
    "bad\u0007bell",
    "hidden‮override",
    ["tok", "en=", "abcd", "1234", "efgh", "5678"].join(""),
    "uses Bearer abcdefghijklmnop",
    ["-----BEGIN ", "PRIVATE KEY-----"].join(""),
    ["gh", "p_", "a1B2".repeat(6)].join(""),
    "A".repeat(48),
  ];
  for (const message of unsafe) {
    const e = await thrown(t, new DaemonError("E_NOT_FOUND", message));
    assert.equal(e.code, "E_NOT_FOUND", message);
    assert.equal(e.message, "Request failed", message);
  }
  assert.equal((await thrown(t, new DaemonError("E_NOT_FOUND", "No such workspace"))).message, "No such workspace");
  const atLimit = "no ".repeat(SAFE_MESSAGE_MAX).slice(0, SAFE_MESSAGE_MAX);
  assert.equal((await thrown(t, new DaemonError("E_NOT_FOUND", atLimit))).message, atLimit);
});

test("S6: details keys come from a per-code allowlist and are bounded", async (t) => {
  assert.deepEqual((await thrown(t, new DaemonError("E_CONFLICT", "Busy", { reason: "in-progress", retryAfterMs: 500 }))).details, {
    reason: "in-progress",
    retryAfterMs: 500,
  });
  const dropped: Array<[ConstructorParameters<typeof DaemonError>[0], Record<string, never>]> = [
    ["E_CONFLICT", { path: "/home/u/.ssh" } as never],
    ["E_NOT_FOUND", { retryAfterMs: 1 } as never],
    ["E_CONFLICT", { reason: "x".repeat(500) } as never],
    ["E_CONFLICT", { retryAfterMs: -1 } as never],
    ["E_CONFLICT", { retryAfterMs: 1e12 } as never],
    ["E_CONFLICT", { reason: ["pass", "word=", "hunter", "22222"].join("") } as never],
    ["E_INTERNAL", { reason: "x" } as never],
  ];
  for (const [code, details] of dropped) {
    const e = await thrown(t, new DaemonError(code, "Nope", details));
    assert.equal(e.code, code);
    assert.equal(e.details, undefined, JSON.stringify(details));
  }
});

// ---- nits ----

test("N1: an identity that fails the schema is refused, not trusted", async (t) => {
  const bad = [
    identityOf({ actor: "root" as never }),
    identityOf({ connectionId: "" }),
    identityOf({ connectionId: "conn-1" }), // not a minted 128-bit id
    identityOf({ actorId: "has space" }),
    { ...identityOf(), trusted: "yes" },
    { ...identityOf(), extra: 1 },
    undefined,
  ];
  for (const identity of bad) {
    const r = rig({ identity: { verify: () => identity as never } });
    t.after(() => r.cleanup());
    assert.ok(await r.inbox.closedWithin(), JSON.stringify(identity));
    assert.equal(r.daemon.connectionCount, 0);
  }
});

test("N3: the pre-identity queue is bounded by count and by bytes", async (t) => {
  for (const [opts, payloads] of [
    [{ maxPendingBeforeIdentity: 2 }, [1, 2, 3]],
    [{ maxPendingBytesBeforeIdentity: 100 }, ["x".repeat(60), "y".repeat(60)]],
  ] as const) {
    let release!: () => void;
    const hold = new Promise<void>((res) => (release = res));
    const r = rig({ ...opts, identity: { verify: async (a) => (await hold, verifier.verify(a)) } });
    t.after(() => r.cleanup());
    for (const p of payloads) r.send(p);
    assert.ok(await r.inbox.closedWithin(), "overflow closes the connection");
    release();
    await wait(20);
    assert.equal(r.daemon.connectionCount, 0);
  }
});

test("N7: memoryPair delivers {data, ports} like Electron; transferred ports are closed and ignored", () => {
  let onMessage!: (e: { data: unknown; ports: Array<{ close(): void }> }) => void;
  const closed: string[] = [];
  const port: ElectronPortLike = {
    on: ((event: string, l: never) => void (event === "message" ? (onMessage = l) : undefined)) as ElectronPortLike["on"],
    postMessage: () => undefined,
    start: () => closed.push("start"),
    close: () => undefined,
  };
  const got: unknown[] = [];
  fromElectronPort(port).onMessage((m) => got.push(m));
  onMessage({ data: { hi: 1 }, ports: [{ close: () => closed.push("p1") }, { close: () => closed.push("p2") }] });
  assert.deepEqual(got, [{ hi: 1 }]);
  assert.deepEqual(closed.sort(), ["p1", "p2", "start"]);
});
