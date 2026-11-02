// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ERROR_CODES,
  PROTOCOL_VERSION,
  cancelEnvelopeSchema,
  inspectMessage,
  MAX_DEPTH,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGE_NODES,
  MAX_STRING_BYTES,
  parseClientMessage,
  clientMessageSchema,
  createRequestSchema,
  errorSchema,
  helloSchema,
  makeError,
  negotiateVersion,
  relativePathSchema,
  removeRequestSchema,
  requestEnvelopeSchema,
  resolveChallengeRequestSchema,
  responseEnvelopeSchema,
  restoreFromRunBaseRequestSchema,
  statusRequestSchema,
  worktreesMethods,
  challengeSchema,
  welcomeSchema,
} from "../src/index.js";

const IDEMPOTENCY_ID = "00000000-0000-4000-8000-000000000001";
const DIGEST = "a".repeat(64);
const CHALLENGE_ID = "A".repeat(22);

const goodRequest = {
  v: 1,
  id: "req-1",
  contract: "axis.worktrees",
  contractVersion: 1,
  method: "create",
  idempotencyKey: IDEMPOTENCY_ID,
  timeoutMs: 5000,
  payload: { projectId: "p1", name: "fix login" },
};

test("request envelope: valid parses", () => {
  assert.equal(requestEnvelopeSchema.safeParse(goodRequest).success, true);
  assert.equal(clientMessageSchema.safeParse(goodRequest).success, true);
});

test("request envelope: rejects unknown keys (identity cannot ride along)", () => {
  for (const extra of ["actor", "workspaceId", "connectionId"]) {
    const r = requestEnvelopeSchema.safeParse(
      JSON.parse(JSON.stringify({ ...goodRequest }).replace(/}$/, `,"${extra}":"x"}`)),
    );
    assert.equal(r.success, false, extra);
  }
});

test("inspectMessage: forbidden keys at any depth", () => {
  assert.deepEqual(inspectMessage(JSON.parse('{"payload":{"a":[{"__proto__":1}]}}')), {
    ok: false,
    reason: "forbidden-key",
  });
  assert.deepEqual(inspectMessage({ constructor: 1 }), { ok: false, reason: "forbidden-key" });
  assert.deepEqual(inspectMessage({ a: { prototype: 1 } }), { ok: false, reason: "forbidden-key" });
  assert.deepEqual(inspectMessage(goodRequest), { ok: true });
});

test("inspectMessage: depth boundary counts the root as level 1", () => {
  const nest = (levels: number): unknown => {
    let v: unknown = 1;
    for (let i = 0; i < levels; i++) v = { a: v };
    return v;
  };
  assert.deepEqual(inspectMessage(nest(MAX_DEPTH)), { ok: true });
  assert.deepEqual(inspectMessage(nest(MAX_DEPTH + 1)), { ok: false, reason: "too-deep" });
  assert.deepEqual(inspectMessage(nest(100_000)), { ok: false, reason: "too-deep" });
});

test("inspectMessage: aliased (DAG) structures return fast instead of expanding", () => {
  let n: unknown = 1;
  for (let i = 0; i < 6; i++) n = new Array(30).fill(n); // 30^6 leaves if walked as a tree
  let t = performance.now();
  assert.deepEqual(inspectMessage(n), { ok: false, reason: "shared-reference" });
  assert.ok(performance.now() - t < 50, "DAG took too long");

  let wide: unknown = 1;
  for (let i = 0; i < 16; i++) wide = new Array(1000).fill(wide);
  t = performance.now();
  assert.equal(inspectMessage(wide).ok, false);
  assert.ok(performance.now() - t < 50, "wide DAG took too long");

  const shared = { a: 1 };
  assert.deepEqual(inspectMessage({ x: shared, y: shared }), { ok: false, reason: "shared-reference" });
});

test("inspectMessage: cycles are rejected", () => {
  const a: Record<string, unknown> = {};
  a["self"] = a;
  assert.equal(inspectMessage(a).ok, false);
  const arr: unknown[] = [];
  arr.push(arr);
  assert.equal(inspectMessage(arr).ok, false);
});

test("inspectMessage: size, string and node budgets", () => {
  assert.deepEqual(inspectMessage("x".repeat(MAX_STRING_BYTES)), { ok: true });
  assert.deepEqual(inspectMessage("x".repeat(MAX_STRING_BYTES + 1)), { ok: false, reason: "too-large" });
  // 4-byte characters count by UTF-8 length, not code units
  assert.deepEqual(inspectMessage("\u{1F600}".repeat(MAX_STRING_BYTES / 4 + 1)), { ok: false, reason: "too-large" });
  // total bytes: many strings each under the string cap
  const many = Array.from({ length: 6 }, () => "y".repeat(MAX_STRING_BYTES - 1));
  assert.deepEqual(inspectMessage(many), { ok: false, reason: "too-large" });
  assert.ok(6 * (MAX_STRING_BYTES - 1) > MAX_MESSAGE_BYTES);
  // keys count too
  assert.deepEqual(inspectMessage({ ["k".repeat(MAX_STRING_BYTES + 1)]: 1 }), { ok: false, reason: "too-large" });
  // node budget
  assert.deepEqual(inspectMessage(new Array(MAX_MESSAGE_NODES).fill(1)), { ok: false, reason: "too-many-nodes" });
  assert.deepEqual(inspectMessage(new Array(MAX_MESSAGE_NODES - 1).fill(1)), { ok: true });
});

test("inspectMessage: values JSON cannot carry are invalid", () => {
  for (const bad of [undefined, () => 1, Symbol("s"), 1n, NaN, Infinity, new Date(), new Map(), { a: undefined }]) {
    assert.equal(inspectMessage(bad).ok, false, String(bad));
  }
  assert.equal(inspectMessage(Object.create(null)).ok, true);
});

test("parseClientMessage rejects an own __proto__ key at any depth", () => {
  const top = JSON.parse(JSON.stringify(goodRequest).replace(/}$/, ',"__proto__":{"x":1}}'));
  assert.deepEqual(parseClientMessage(top), { ok: false, reason: "forbidden-key" });
  const nested = JSON.parse(
    '{"v":1,"id":"r","contract":"axis.worktrees","contractVersion":1,"method":"create","payload":{"a":[{"__proto__":{"polluted":true}}]}}',
  );
  assert.deepEqual(parseClientMessage(nested), { ok: false, reason: "forbidden-key" });
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  assert.equal(parseClientMessage(goodRequest).ok, true);
  assert.deepEqual(parseClientMessage({ v: 1 }), { ok: false, reason: "invalid" });
});

test("parseClientMessage covers hello, request and cancel", () => {
  const hello = { type: "hello", protocolVersions: [1], contracts: [{ id: "axis.worktrees", versions: [1] }] };
  assert.equal(parseClientMessage(hello).ok, true);
  assert.equal(parseClientMessage({ v: 1, cancel: "r" }).ok, true);
  const own = JSON.parse('{"type":"hello","protocolVersions":[1],"contracts":[],"__proto__":{"x":1}}');
  assert.deepEqual(parseClientMessage(own), { ok: false, reason: "forbidden-key" });
  assert.equal(parseClientMessage({ ...hello, protocolVersions: [1, 1] }).ok, false);
});

test("parseClientMessage rejects oversized payloads and aliased messages", () => {
  const big = { ...goodRequest, payload: { text: "z".repeat(5 * 1024 * 1024) } };
  assert.deepEqual(parseClientMessage(big), { ok: false, reason: "too-large" });
  const shared = { n: 1 };
  assert.deepEqual(parseClientMessage({ ...goodRequest, payload: { a: shared, b: shared } }), {
    ok: false,
    reason: "shared-reference",
  });
});

test("request envelope: rejects bad fields", () => {
  const bad: Record<string, unknown>[] = [
    { ...goodRequest, v: 0 },
    { ...goodRequest, v: 1.5 },
    { ...goodRequest, id: "" },
    { ...goodRequest, id: "x".repeat(65) },
    { ...goodRequest, contract: "worktrees" },
    { ...goodRequest, method: "a/b" },
    { ...goodRequest, idempotencyKey: "not-a-uuid" },
    { ...goodRequest, timeoutMs: 0 },
    { ...goodRequest, timeoutMs: 31_000 },
  ];
  for (const b of bad) assert.equal(requestEnvelopeSchema.safeParse(b).success, false, JSON.stringify(b));
  const { payload: _omit, ...noPayload } = goodRequest;
  assert.equal(requestEnvelopeSchema.safeParse(noPayload).success, false);
});

test("cancel envelope", () => {
  assert.equal(cancelEnvelopeSchema.safeParse({ v: 1, cancel: "req-1" }).success, true);
  assert.equal(cancelEnvelopeSchema.safeParse({ v: 1, cancel: "" }).success, false);
  assert.equal(clientMessageSchema.safeParse({ v: 1, cancel: "req-1" }).success, true);
});

test("errors: every code round-trips; unknown code rejected", () => {
  for (const code of ERROR_CODES) {
    if (code === "E_APPROVAL_REQUIRED") continue;
    const e = makeError(code, "m", "corr-1");
    assert.equal(errorSchema.safeParse(e).success, true, code);
  }
  assert.equal(makeError("E_BACKPRESSURE", "m", "c").retryable, true);
  assert.equal(makeError("E_POLICY_DENIED", "m", "c").retryable, false);
  assert.equal(errorSchema.safeParse({ ...makeError("E_INTERNAL", "m", "c"), code: "E_DENIED" }).success, false);
  assert.equal(errorSchema.safeParse({ ...makeError("E_INTERNAL", "m", "c"), stack: "at x" }).success, false);
  assert.equal(makeError("E_INTERNAL", "x".repeat(5000), "c").message.length, 1024);
});

test("errors: E_APPROVAL_REQUIRED must carry a challenge; details are bounded", () => {
  assert.equal(errorSchema.safeParse(makeError("E_APPROVAL_REQUIRED", "m", "c")).success, false);
  const challenge = {
    challengeId: CHALLENGE_ID,
    digest: DIGEST,
    contract: "axis.worktrees",
    method: "remove",
    tier: 4,
    targetSummary: "Remove workspace",
    nativeConfirmationRequired: true,
    expiresAt: 1_800_000_000_000,
  };
  assert.equal(errorSchema.safeParse(makeError("E_APPROVAL_REQUIRED", "m", "c", { challenge })).success, true);
  const many: Record<string, number> = {};
  for (let i = 0; i < 17; i++) many[`k${i}`] = i;
  assert.equal(errorSchema.safeParse(makeError("E_INTERNAL", "m", "c", many)).success, false);
  assert.equal(errorSchema.safeParse(makeError("E_INTERNAL", "m", "c", { t: "x".repeat(MAX_STRING_BYTES + 1) })).success, false);
  // truncation never leaves a lone surrogate
  const cut = makeError("E_INTERNAL", "a".repeat(1023) + "\u{1F600}", "c").message;
  assert.equal(cut, "a".repeat(1023));
});

test("response envelope is a discriminated union", () => {
  assert.equal(responseEnvelopeSchema.safeParse({ v: 1, id: "r", ok: true, result: { a: 1 } }).success, true);
  assert.equal(
    responseEnvelopeSchema.safeParse({ v: 1, id: "r", ok: false, error: makeError("E_NOT_FOUND", "m", "c") }).success,
    true,
  );
  assert.equal(responseEnvelopeSchema.safeParse({ v: 1, id: "r", ok: true, error: makeError("E_NOT_FOUND", "m", "c") }).success, false);
  assert.equal(responseEnvelopeSchema.safeParse({ v: 1, id: "r", ok: false, result: 1 }).success, false);
});

test("version negotiation", () => {
  assert.deepEqual(negotiateVersion([1]), { ok: true, version: 1 });
  assert.deepEqual(negotiateVersion([3, 2, 1]), { ok: true, version: 1 });
  assert.deepEqual(negotiateVersion([2, 3]), { ok: false });
  assert.deepEqual(negotiateVersion([]), { ok: false });
  assert.deepEqual(negotiateVersion([1, 2, 3], [1, 2]), { ok: true, version: 2 });
  assert.equal(PROTOCOL_VERSION, 1);
});

test("hello / welcome", () => {
  const hello = {
    type: "hello",
    protocolVersions: [1],
    contracts: [{ id: "axis.worktrees", versions: [1] }],
  };
  assert.equal(helloSchema.safeParse(hello).success, true);
  assert.equal(helloSchema.safeParse({ ...hello, protocolVersions: [] }).success, false);
  assert.equal(helloSchema.safeParse({ ...hello, contracts: [{ id: "axis.worktrees", versions: [] }] }).success, false);
  assert.equal(helloSchema.safeParse({ ...hello, protocolVersions: new Array(17).fill(1) }).success, false);
  const welcome = {
    type: "welcome",
    protocolVersion: 1,
    contracts: [{ id: "axis.worktrees", version: 1 }],
    limits: { maxMessageBytes: 1048576, maxInFlight: 32, maxTimeoutMs: 30000 },
  };
  assert.equal(welcomeSchema.safeParse(welcome).success, true);
  assert.equal(welcomeSchema.safeParse({ ...welcome, limits: { ...welcome.limits, maxTimeoutMs: 60000 } }).success, false);
});

test("worktrees: create", () => {
  assert.equal(createRequestSchema.safeParse({ projectId: "p1", name: "n" }).success, true);
  assert.equal(createRequestSchema.safeParse({ projectId: "p1", name: "n", baseRef: "main" }).success, true);
  // no path field is accepted
  assert.equal(createRequestSchema.safeParse({ projectId: "p1", name: "n", path: "/tmp/x" }).success, false);
  assert.equal(createRequestSchema.safeParse({ projectId: "../x", name: "n" }).success, false);
  assert.equal(createRequestSchema.safeParse({ projectId: "p1", name: "" }).success, false);
  assert.equal(createRequestSchema.safeParse({ projectId: "p1", name: "n", baseRef: "--upload-pack=x" }).success, false);
  assert.equal(createRequestSchema.safeParse({ projectId: "p1", name: "n", baseRef: "a..b" }).success, false);
  assert.equal(createRequestSchema.safeParse({ projectId: "p1", name: "n\u0000" }).success, false);
});

test("worktrees: status bounds", () => {
  assert.equal(statusRequestSchema.safeParse({ ids: ["a"] }).success, true);
  assert.equal(statusRequestSchema.safeParse({ ids: [] }).success, false);
  assert.equal(statusRequestSchema.safeParse({ ids: new Array(101).fill("a") }).success, false);
});

test("worktrees: relative paths", () => {
  for (const ok of ["a.txt", "src/a/b.ts", "dir with space/f"]) {
    assert.equal(relativePathSchema.safeParse(ok).success, true, ok);
  }
  for (const bad of ["", "/etc/passwd", "../x", "a/../b", "a//b", "./a", "C:\\x", "a\\b", "a\0b"]) {
    assert.equal(relativePathSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
  assert.equal(
    restoreFromRunBaseRequestSchema.safeParse({ runId: "r1", id: "w1", paths: ["a.txt"] }).success,
    true,
  );
  assert.equal(restoreFromRunBaseRequestSchema.safeParse({ runId: "r1", id: "w1", paths: [] }).success, false);
  assert.equal(
    restoreFromRunBaseRequestSchema.safeParse({ runId: "r1", id: "w1", paths: new Array(501).fill("a") }).success,
    false,
  );
});

test("worktrees: remove carries an optional challenge reference", () => {
  assert.equal(removeRequestSchema.safeParse({ id: "w1" }).success, true);
  assert.equal(
    removeRequestSchema.safeParse({ id: "w1", deleteBranch: true, approval: { challengeId: CHALLENGE_ID } }).success,
    true,
  );
  assert.equal(removeRequestSchema.safeParse({ id: "w1", approval: { challengeId: "short" } }).success, false);
  assert.equal(removeRequestSchema.safeParse({ id: "w1", force: true }).success, false);
});

test("worktrees: method table matches the design (tiers, side effects, idempotency)", () => {
  assert.deepEqual(Object.keys(worktreesMethods).sort(), [
    "create", "finalise", "list", "remove", "restoreFromRunBase", "status",
  ]);
  assert.equal(worktreesMethods.remove.tier, 4);
  assert.equal(worktreesMethods.remove.sideEffect, "destructive");
  for (const m of ["create", "finalise", "remove", "restoreFromRunBase"] as const) {
    assert.equal(worktreesMethods[m].idempotency, "required", m);
  }
  for (const m of ["list", "status"] as const) {
    assert.equal(worktreesMethods[m].sideEffect, "read", m);
    assert.equal(worktreesMethods[m].tier, 0, m);
  }
});

test("challenge: shape and resolve request", () => {
  const challenge = {
    challengeId: CHALLENGE_ID,
    digest: DIGEST,
    contract: "axis.worktrees",
    method: "remove",
    tier: 4,
    targetSummary: "Remove workspace fix-login",
    nativeConfirmationRequired: true,
    expiresAt: 1_800_000_000_000,
  };
  assert.equal(challengeSchema.safeParse(challenge).success, true);
  assert.equal(challengeSchema.safeParse({ ...challenge, tier: 6 }).success, false);
  assert.equal(challengeSchema.safeParse({ ...challenge, digest: "xyz" }).success, false);
  const resolve = { challengeId: CHALLENGE_ID, decision: "approve", digest: DIGEST };
  assert.equal(resolveChallengeRequestSchema.safeParse(resolve).success, true);
  assert.equal(resolveChallengeRequestSchema.safeParse({ ...resolve, decision: "maybe" }).success, false);
  // the caller cannot name who approved
  assert.equal(resolveChallengeRequestSchema.safeParse({ ...resolve, approver: "user" }).success, false);
});
