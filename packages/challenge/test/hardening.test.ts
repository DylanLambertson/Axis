// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { challengeSchema, errorSchema } from "@axis/protocol";
import { ChallengeError, ChallengeManager, canonicalJson, requestDigest, type ChallengeAuditEvent } from "../src/index.js";
import { ARGS, CALLER, CONN, CONTENT, CONTRACT, WIN, approve, code, internal, issue, resolveArgs, run, setup } from "./helpers.js";

test("S6: a wall-clock rollback does not extend a confirmation past its TTL", async () => {
  const { manager, clock } = setup();
  const token = approve(manager, issue(manager));
  clock.t += 25_000; // 25 s really pass
  clock.skew -= 3_600_000; // the wall clock steps back an hour
  clock.t += 10_000; // 35 s elapsed in total, beyond the 30 s confirmation TTL
  let ran = 0;
  await assert.rejects(manager.consume(token, CALLER, run, () => void ran++), code("E_CONFLICT"));
  assert.equal(ran, 0);
});

test("S6: a wall-clock rollback does not keep a stale challenge alive, and the wire expiresAt is wall time", () => {
  const { manager, clock } = setup({ ttl: 10_000 });
  const issued = issue(manager);
  assert.equal(issued.challenge.expiresAt, clock.t + clock.skew + 10_000);
  clock.skew -= 3_600_000;
  clock.t += 10_000;
  assert.equal(manager.resolve(...resolveArgs(issued)).state, "expired");
});

test("S3: a challenge that cannot be built leaves no record and fails with a protocol code", () => {
  for (const wall of [-5, Number.NaN, Number.MAX_SAFE_INTEGER]) {
    const m = new ChallengeManager({ audit: { append: () => undefined }, now: () => wall });
    assert.throws(() => issue(m), (e: unknown) => e instanceof ChallengeError && e.code === "E_INTERNAL");
    assert.equal(m.outstanding(), 0);
  }
  const events: ChallengeAuditEvent[] = [];
  const m = new ChallengeManager({ audit: { append: (e) => void events.push(e) }, now: () => -1 });
  assert.throws(() => issue(m), code("E_INTERNAL"));
  assert.equal(events.length, 0, "nothing is audited for a challenge that was never created");
});

test("S3: a fractional wall clock (performance.now style) still yields an integer expiresAt", () => {
  const m = new ChallengeManager({ audit: { append: () => undefined }, now: () => 1_000_000.5 });
  const c = issue(m).challenge;
  assert.equal(c.expiresAt, 1_060_000);
  assert.doesNotThrow(() => challengeSchema.parse(c));
  assert.equal(m.outstanding(), 1);
});

test("S2: sink failures at every phase surface as E_INTERNAL and never as a raw Error", async () => {
  const wireValid = (e: unknown): boolean => {
    assert.ok(e instanceof ChallengeError, String(e));
    assert.equal(e.code, "E_INTERNAL");
    assert.doesNotThrow(() => errorSchema.parse(e.toWire("c")));
    assert.ok(!/sink down/.test(e.message));
    return true;
  };
  const failOn = (s: ReturnType<typeof setup>, phase: string) => s.failWhen((e) => e.payload["phase"] === phase);
  const s1 = setup();
  failOn(s1, "issued");
  assert.throws(() => issue(s1.manager), wireValid);
  const s2 = setup();
  const i2 = issue(s2.manager);
  failOn(s2, "resolve");
  assert.throws(() => s2.manager.resolve(...resolveArgs(i2)), wireValid);
  const s3 = setup();
  const i3 = issue(s3.manager);
  s3.manager.resolve(...resolveArgs(i3));
  failOn(s3, "native");
  assert.throws(() => s3.manager.confirmNative({ windowId: WIN }, { challengeId: i3.challenge.challengeId, proof: i3.nativeProof ?? "", confirmed: true }), wireValid);
  const s4 = setup();
  const t4 = approve(s4.manager, issue(s4.manager));
  failOn(s4, "authorised");
  await assert.rejects(s4.manager.consume(t4, CALLER, run, () => 1), (e: unknown) => wireValid(e) && internal(false)(e));
});

test("S2: when the action fails and the error audit also fails, the caller still learns the action ran", async () => {
  const s = setup();
  const token = approve(s.manager, issue(s.manager));
  s.failWhen((e) => e.outcome === "error");
  await assert.rejects(
    s.manager.consume(token, CALLER, run, () => {
      throw new Error("action broke");
    }),
    internal(true),
  );
});

test("S2: whatever the action throws, only a wire-valid ChallengeError escapes", async () => {
  const thrown: unknown[] = [new ChallengeError("E_APPROVAL_REQUIRED", "x"), "text", null, { code: "E_CONFLICT" }, new RangeError("r")];
  for (const t of thrown) {
    const { manager } = setup();
    const token = approve(manager, issue(manager));
    await assert.rejects(
      manager.consume(token, CALLER, run, () => {
        throw t;
      }),
      (e: unknown) => {
        assert.ok(e instanceof ChallengeError);
        assert.equal(e.code, "E_INTERNAL");
        assert.doesNotThrow(() => errorSchema.parse(e.toWire("c")));
        return true;
      },
    );
  }
});

test("S7: a deny takes effect even when the audit sink fails, and the caller gets E_INTERNAL", () => {
  const s = setup({});
  const a = issue(s.manager);
  s.failWhen((e) => e.payload["decision"] === "deny");
  assert.throws(() => s.manager.resolve(...resolveArgs(a, { decision: "deny" })), code("E_INTERNAL"));
  s.failWhen(undefined);
  assert.throws(() => s.manager.resolve(...resolveArgs(a)), code("E_CONFLICT"), "an approve cannot follow the deny");

  const b = issue(s.manager);
  s.manager.resolve(...resolveArgs(b));
  s.failWhen((e) => e.payload["decision"] === "cancel");
  assert.throws(() => s.manager.confirmNative({ windowId: WIN }, { challengeId: b.challenge.challengeId, proof: b.nativeProof ?? "", confirmed: false }), code("E_INTERNAL"));
  s.failWhen(undefined);
  assert.throws(() => s.manager.confirmNative({ windowId: WIN }, { challengeId: b.challenge.challengeId, proof: b.nativeProof ?? "", confirmed: true }), code("E_CONFLICT"), "a cancelled dialog cannot be re-confirmed");
});

test("S5: bidi, zero-width, line-break and control characters are refused in target and summary", () => {
  const { manager } = setup();
  const bad = ["ws-‮gnp.txt", "ws-⁦x", "ws-​x", "ws-﻿x", "ws-1\n\nSafe: nothing will be deleted", "a\u0085b", "a b", "a b", "a\u007fb", "a\uD800b"];
  for (const text of bad) {
    assert.throws(() => issue(manager, { target: text }), code("E_INVALID_ARGUMENT"), `target ${JSON.stringify(text)}`);
    assert.throws(() => issue(manager, { targetSummary: text }), code("E_INVALID_ARGUMENT"), `summary ${JSON.stringify(text)}`);
  }
  assert.equal(manager.outstanding(), 0);
  assert.doesNotThrow(() => issue(manager, { target: "workspace:é中\u{1F600}", targetSummary: "café 中" }));
});

test("S5: execute also refuses a display-unsafe target", async () => {
  const { manager } = setup();
  const token = approve(manager, issue(manager));
  await assert.rejects(manager.consume(token, CALLER, { ...run, target: "workspace:ws-1‮" }, () => 1), code("E_INVALID_ARGUMENT"));
});

test("S4: the default summary is the whole target when it fits, and keeps head and tail when it does not", () => {
  const { manager } = setup();
  const exact = "workspace:" + "a".repeat(502);
  assert.equal(issue(manager, { target: exact }).challenge.targetSummary, exact);
  const long = "workspace:" + "a".repeat(600) + "/../../home";
  const summary = issue(manager, { target: long }).challenge.targetSummary;
  assert.ok(summary.length <= 512);
  assert.ok(summary.startsWith("workspace:aaa"));
  assert.ok(summary.endsWith("/../../home"), "the tail is visible");
  assert.ok(summary.includes("…"), "the cut is visible");
});

test("S4: cutting never splits a surrogate pair", () => {
  for (let pad = 250; pad < 260; pad++) {
    const { manager } = setup();
    const target = "a".repeat(pad) + "\u{1F600}".repeat(200) + "b".repeat(pad);
    const summary = issue(manager, { target }).challenge.targetSummary;
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(summary), `pad ${pad}`);
    assert.ok(summary.length <= 512);
  }
});

// B1 (APR-1, G-24): contract and arguments are bound into the challenge.
const pair = (contract: string) => ({ contract, args: ARGS });

test("B1: the challenge digest covers the contract", () => {
  const { manager } = setup();
  const a = issue(manager, pair("axis.worktrees/1"));
  const b = issue(manager, pair("axis.terminals/1"));
  assert.notEqual(a.challenge.digest, b.challenge.digest);
});

test("B1: the digest covers the arguments and ignores key order", () => {
  const { manager } = setup();
  const a = issue(manager, { args: { id: "ws-1", deleteBranch: false, nested: { x: 1, y: [1, 2] } } });
  const b = issue(manager, { args: { nested: { y: [1, 2], x: 1 }, deleteBranch: false, id: "ws-1" } });
  const c = issue(manager, { args: { id: "ws-1", deleteBranch: true, nested: { x: 1, y: [1, 2] } } });
  const d = issue(manager, { args: { id: "ws-1", deleteBranch: false, nested: { x: 1, y: [2, 1] } } });
  assert.equal(a.challenge.digest, b.challenge.digest);
  assert.notEqual(a.challenge.digest, c.challenge.digest);
  assert.notEqual(a.challenge.digest, d.challenge.digest, "array order matters");
});

test("B1: approval of remove{deleteBranch:false} does not authorise remove{deleteBranch:true}; the attempt burns it", async () => {
  const { manager, events } = setup();
  const token = approve(manager, issue(manager, { args: { id: "ws-1", deleteBranch: false } }));
  let branchDeleted = false;
  const retried = { id: "ws-1", deleteBranch: true };
  await assert.rejects(
    manager.consume(token, CALLER, { ...run, args: retried }, () => {
      branchDeleted = retried.deleteBranch;
    }),
    code("E_POLICY_DENIED"),
  );
  assert.equal(branchDeleted, false);
  await assert.rejects(manager.consume(token, CALLER, { ...run, args: { id: "ws-1", deleteBranch: false } }, () => 1), code("E_CONFLICT"), "burned: even the approved arguments cannot reuse it");
  assert.equal(events.filter((e) => e.payload["reason"] === "request_mismatch").length, 1);
});

test("B1: a different contract or an extra or missing argument is refused at execute", async () => {
  const variants: Array<Record<string, unknown>> = [
    { contract: "axis.terminals/1" },
    { args: { id: "ws-1" } },
    { args: { id: "ws-1", deleteBranch: false, force: true } },
    { args: { id: "ws-2", deleteBranch: false } },
  ];
  for (const v of variants) {
    const { manager } = setup();
    const token = approve(manager, issue(manager));
    let ran = 0;
    await assert.rejects(manager.consume(token, CALLER, { ...run, ...v }, () => void ran++), code("E_POLICY_DENIED"));
    assert.equal(ran, 0);
  }
});

test("B1: args and contract are validated: bounded plain objects only, contract shaped like name/version", () => {
  const { manager } = setup();
  const big = { blob: "x".repeat(20_000) };
  for (const bad of [{ args: big }, { args: [1] }, { args: null }, { args: "s" }, { args: { n: Number.NaN } }, { contract: "nope" }, { contract: "" }]) {
    assert.throws(() => issue(manager, bad as never), code("E_INVALID_ARGUMENT"));
  }
  assert.throws(() => manager.issue({ method: "worktree.discard", target: "t", contentDigest: CONTENT, actor: "user", windowId: WIN } as never), code("E_INVALID_ARGUMENT"), "contract and args are required");
  assert.equal(manager.outstanding(), 0);
});

test("B1: canonicalJson sorts keys at every depth and keeps array order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
});

// S1 (APR-1): an approval is bound to the requester and its connection, and the challenge id is not a bearer credential.
test("S1: another agent, the renderer or another connection cannot consume an approved challenge, and a refusal burns nothing", async () => {
  const { manager, events } = setup();
  const id = approve(manager, issue(manager, { actor: "agent:run-A", connectionId: "conn-A" }));
  let ran = 0;
  const impostors = [
    { actor: "agent:run-B", connectionId: "conn-A" },
    { actor: "agent:run-A", connectionId: "conn-B" },
    { actor: "user", connectionId: "conn-A" },
    { actor: "daemon", connectionId: "conn-A" },
  ];
  for (const caller of impostors) {
    await assert.rejects(manager.consume(id, caller, run, () => void ran++), code("E_POLICY_DENIED"));
  }
  assert.equal(ran, 0);
  assert.equal(events.filter((e) => e.payload["reason"] === "wrong_caller").length, impostors.length);
  assert.equal(await manager.consume(id, { actor: "agent:run-A", connectionId: "conn-A" }, run, () => "ok"), "ok", "the real requester still can");
});

test("S1: consume does not depend on the audit log to refuse a wrong caller", async () => {
  const s = setup();
  const id = approve(s.manager, issue(s.manager, { actor: "agent:run-A", connectionId: "conn-A" }));
  s.failWhen(() => true);
  await assert.rejects(s.manager.consume(id, CALLER, run, () => 1), code("E_POLICY_DENIED"));
});

test("S1: caller identity is validated and a malformed caller is E_INVALID_ARGUMENT", async () => {
  const { manager } = setup();
  const id = approve(manager, issue(manager));
  for (const caller of [{}, { actor: "root", connectionId: CONN }, { actor: "user" }, { actor: "user", connectionId: CONN, extra: 1 }]) {
    await assert.rejects(manager.consume(id, caller as never, run, () => 1), code("E_INVALID_ARGUMENT"));
  }
  await assert.rejects(manager.consume(id, CALLER, run, "nope" as never), code("E_INVALID_ARGUMENT"));
  assert.equal(await manager.consume(id, CALLER, run, () => 1), 1, "invalid input burned nothing");
});

test("S1: the API exposes no bearer token: resolve results carry no secret and nothing but consume runs an action", () => {
  const { manager } = setup();
  const issued = issue(manager);
  const r = manager.resolve(...resolveArgs(issued));
  assert.deepEqual(Object.keys(r).sort(), ["challengeId", "nativeRequired", "state"]);
  assert.equal((manager as unknown as Record<string, unknown>)["execute"], undefined);
});

// N1, N2: no existence oracle; identity is a separate, attested argument.
test("N1: unknown id, non-user actor and wrong window are indistinguishable, even with a failing audit sink", () => {
  const s = setup();
  const real = issue(s.manager, { actor: "agent:run-A" });
  const ghost = { ...real, challenge: { ...real.challenge, challengeId: "A".repeat(43) } };
  const outcome = (fn: () => unknown): string => {
    try {
      fn();
      return "no error";
    } catch (e) {
      return e instanceof ChallengeError ? `${e.code}|${e.message}|${JSON.stringify(e.detail)}` : String(e);
    }
  };
  for (const sinkDown of [false, true]) {
    s.failWhen(sinkDown ? () => true : undefined);
    const results = new Set([
      outcome(() => s.manager.resolve(...resolveArgs(real, { actor: "agent:run-A" }))),
      outcome(() => s.manager.resolve(...resolveArgs(ghost, { actor: "agent:run-A" }))),
      outcome(() => s.manager.resolve(...resolveArgs(real, { windowId: "window-2" }))),
      outcome(() => s.manager.resolve(...resolveArgs(ghost))),
      outcome(() => s.manager.confirmNative({ windowId: "window-2" }, { challengeId: real.challenge.challengeId, proof: "p", confirmed: true })),
      outcome(() => s.manager.confirmNative({ windowId: WIN }, { challengeId: ghost.challenge.challengeId, proof: "p", confirmed: true })),
    ]);
    assert.equal(results.size, 1, [...results].join("\n"));
    assert.ok([...results][0]?.startsWith("E_POLICY_DENIED|"));
  }
});

test("N2: the attested caller is a separate argument; a payload that carries identity is refused", () => {
  const { manager } = setup();
  const issued = issue(manager, { actor: "agent:run-A" });
  const [, request] = resolveArgs(issued);
  assert.throws(() => manager.resolve({ actor: "agent:run-A", windowId: WIN }, { ...request, actor: "user", windowId: WIN } as never), code("E_INVALID_ARGUMENT"));
  assert.throws(() => manager.resolve({ actor: "agent:run-A", windowId: WIN }, request), code("E_POLICY_DENIED"));
  assert.throws(() => manager.resolve({ actor: "user", windowId: WIN, extra: 1 } as never, request), code("E_INVALID_ARGUMENT"));
  assert.equal(manager.resolve({ actor: "user", windowId: WIN }, request).state, "approved");
});

// N3: the native proof never travels in the object the renderer sees.
test("N3: issue returns only the wire challenge; the native proof comes out once, through takeNativeProof", () => {
  const { manager } = setup();
  const challenge = manager.issue({ contract: CONTRACT, version: 1, method: "worktree.discard", target: "workspace:ws-1", args: ARGS, contentDigest: CONTENT, actor: "user", connectionId: CONN, windowId: WIN });
  assert.deepEqual(Object.keys(challenge).sort(), Object.keys(challengeSchema.shape).sort());
  const proof = manager.takeNativeProof(challenge.challengeId);
  assert.ok(proof);
  assert.ok(!JSON.stringify(challenge).includes(proof));
  assert.equal(manager.takeNativeProof(challenge.challengeId), null, "only once");
  assert.equal(manager.takeNativeProof("A".repeat(43)), null, "unknown id");
  assert.equal(manager.takeNativeProof("short"), null, "malformed id");
  manager.resolve(...resolveArgs({ challenge, nativeProof: proof }));
  assert.equal(manager.confirmNative({ windowId: WIN }, { challengeId: challenge.challengeId, proof, confirmed: true }).state, "approved", "taking the proof does not consume it");
});

test("N3: a tier with no native step has no proof to take", () => {
  const { manager } = setup();
  const challenge = issue(manager, { tier: 3 }).challenge;
  assert.equal(manager.takeNativeProof(challenge.challengeId), null);
});

// N4: a per-window bound.
test("N4: one window's backlog cannot use every slot; other windows keep theirs", () => {
  const events: ChallengeAuditEvent[] = [];
  const manager = new ChallengeManager({ audit: { append: (e) => void events.push(e) }, maxOutstandingPerWindow: 3, maxOutstandingPerActor: 100 });
  const mk = (n: number, windowId: string) => issue(manager, { actor: `agent:run-${n}`, windowId });
  [1, 2, 3].forEach((n) => mk(n, "window-1"));
  assert.throws(() => mk(4, "window-1"), code("E_BACKPRESSURE"));
  assert.doesNotThrow(() => mk(5, "window-2"));
  assert.equal(manager.outstanding(undefined, "window-1"), 3);
  const first = issue(manager, { actor: "agent:run-6", windowId: "window-2" });
  manager.resolve(...resolveArgs(first, { windowId: "window-2", decision: "deny" }));
  assert.doesNotThrow(() => mk(7, "window-2"), "a resolved challenge frees its slot");
  assert.throws(() => new ChallengeManager({ audit: { append: () => undefined }, maxOutstandingPerWindow: 0 }), code("E_INVALID_ARGUMENT"));
});

// N6: the audit log records a hash of the target, never the raw target.
test("N6: audit events carry a hash of the target, stable per target, and never the raw target", async () => {
  const { manager, events } = setup();
  const target = "workspace:ws-secret-name";
  const id = approve(manager, issue(manager, { target }));
  await manager.consume(id, CALLER, { ...run, target }, () => 1);
  const dump = JSON.stringify(events);
  assert.ok(!dump.includes("ws-secret-name"));
  const expected = `sha256:${createHash("sha256").update(target).digest("hex")}`;
  assert.ok(events.length >= 5);
  for (const e of events) assert.equal(e.target, expected);
});

test("every error any entry point raises parses with errorSchema and uses a protocol code other than E_APPROVAL_REQUIRED", async () => {
  const s = setup({ ttl: 10_000, confirmTtl: 5_000 });
  const errors: unknown[] = [];
  const sync = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      errors.push(e);
    }
  };
  const issued = issue(s.manager, { actor: "agent:run-A", connectionId: "conn-A" });
  sync(() => new ChallengeManager({ audit: { append: () => undefined }, challengeTtlMs: 0 }));
  sync(() => s.manager.issue({} as never));
  sync(() => s.manager.resolve({ actor: "agent:run-A", windowId: WIN }, resolveArgs(issued)[1]));
  sync(() => s.manager.resolve({ actor: "user", windowId: WIN }, { ...resolveArgs(issued)[1], digest: "0".repeat(64) }));
  sync(() => s.manager.resolve(...resolveArgs(issued)));
  sync(() => s.manager.confirmNative({ windowId: WIN }, { challengeId: issued.challenge.challengeId, proof: "nope", confirmed: true }));
  sync(() => s.manager.confirmNative({ windowId: "x y" }, {} as never));
  s.failWhen(() => true);
  sync(() => issue(s.manager));
  s.failWhen(undefined);
  const id = approve(s.manager, issue(s.manager));
  await s.manager.consume(id, { actor: "agent:z", connectionId: CONN }, run, () => 1).catch((e: unknown) => errors.push(e));
  await s.manager.consume(id, CALLER, { ...run, args: { other: 1 } }, () => 1).catch((e: unknown) => errors.push(e));
  await s.manager.consume(id, CALLER, run, () => 1).catch((e: unknown) => errors.push(e));
  const id2 = approve(s.manager, issue(s.manager));
  await s.manager.consume(id2, CALLER, run, () => Promise.reject(new Error("boom"))).catch((e: unknown) => errors.push(e));
  const id3 = approve(s.manager, issue(s.manager));
  s.clock.t += 5_000;
  await s.manager.consume(id3, CALLER, run, () => 1).catch((e: unknown) => errors.push(e));
  assert.ok(errors.length >= 12, `collected ${errors.length}`);
  for (const e of errors) {
    assert.ok(e instanceof ChallengeError, String(e));
    assert.notEqual(e.code, "E_APPROVAL_REQUIRED");
    assert.doesNotThrow(() => errorSchema.parse(e.toWire("corr-1")));
  }
});

// B1 follow-up: the daemon may pass a precomputed request digest instead of (or with) the args.
test("B1: a precomputed requestDigest can replace args, and must agree when both are given", async () => {
  const pre = requestDigest({ contract: CONTRACT, version: 1, method: "worktree.discard", payload: ARGS });
  const { manager } = setup();
  const digestOnly = (({ args: _a, ...rest }) => rest)({ ...run, requestDigest: pre });
  const id = approve(manager, issue(manager, { args: undefined, requestDigest: pre } as never));
  assert.equal(await manager.consume(id, CALLER, digestOnly as never, () => "ok"), "ok");

  assert.throws(() => issue(manager, { requestDigest: "0".repeat(64) }), code("E_INVALID_ARGUMENT"), "args and digest disagree");
  assert.throws(() => issue(manager, { args: undefined } as never), code("E_INVALID_ARGUMENT"), "neither given");

  const id2 = approve(manager, issue(manager));
  await assert.rejects(manager.consume(id2, CALLER, { ...run, args: undefined, requestDigest: requestDigest({ contract: CONTRACT, version: 1, method: "worktree.discard", payload: { ...ARGS, deleteBranch: true } }) } as never, () => 1), code("E_POLICY_DENIED"));
});

test("B1: a different version or method is refused at consume and burns the approval", async () => {
  for (const v of [{ version: 2 }, { method: "worktree.remove" }]) {
    const { manager } = setup();
    const id = approve(manager, issue(manager));
    await assert.rejects(manager.consume(id, CALLER, { ...run, ...v }, () => 1), code("E_POLICY_DENIED"));
    await assert.rejects(manager.consume(id, CALLER, run, () => 1), code("E_CONFLICT"));
  }
});

// Fixed vectors for the shared digest spec. Hex values were produced by an independent implementation (Python hashlib and json).
test("requestDigest fixed vectors: unsorted keys, an ignored approval field, nested values and Unicode", () => {
  const ref = { challengeId: "A".repeat(43) };
  const cases: Array<[string, number, string, unknown, string]> = [
    ["axis.worktrees/1", 1, "remove", { id: "ws-1", deleteBranch: false }, "ccb3a71aa0bc5bd6db5ccfe6fe9a09abef12092dce13ba4f6d99e929a30e0fd7"],
    ["axis.worktrees/1", 1, "remove", { deleteBranch: false, approval: ref, id: "ws-1" }, "ccb3a71aa0bc5bd6db5ccfe6fe9a09abef12092dce13ba4f6d99e929a30e0fd7"],
    ["axis.demo/1", 2, "nested", { z: [3, { b: null, a: true }], a: { y: 1.5, x: "s" } }, "1ea2792869f10b78f4046228b72597c0e6951811e63ada0d0cf788001f107488"],
    ["axis.demo/1", 1, "unicode", { name: "café 中文 \u{1F600}", "kéy": "é" }, "ce1aa20bb3e2bf2910fd4f737e18ed5fe8a063498622376d982ec1456c3e3738"],
    ["axis.demo/1", 1, "empty", {}, "98df99cd17dc8f6dae1c493391c1a298dc271d44da171fd4f03c88fda545cc4b"],
  ];
  for (const [contract, version, method, payload, hex] of cases) {
    assert.equal(requestDigest({ contract, version, method, payload }), hex, `${contract} v${version} ${method}`);
  }
});
