// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { challengeSchema, errorSchema } from "@axis/protocol";
import { ChallengeError, ChallengeManager, canonicalJson, type ChallengeAuditEvent } from "../src/index.js";
import { ARGS, CONTENT, WIN, approve, code, internal, issue, resolveArgs, run, setup } from "./helpers.js";

test("S6: a wall-clock rollback does not extend a confirmation past its TTL", async () => {
  const { manager, clock } = setup();
  const token = approve(manager, issue(manager));
  clock.t += 25_000; // 25 s really pass
  clock.skew -= 3_600_000; // the wall clock steps back an hour
  clock.t += 10_000; // 35 s elapsed in total, beyond the 30 s confirmation TTL
  let ran = 0;
  await assert.rejects(manager.execute(token, run, () => void ran++), code("E_CONFLICT"));
  assert.equal(ran, 0);
});

test("S6: a wall-clock rollback does not keep a stale challenge alive, and the wire expiresAt is wall time", () => {
  const { manager, clock } = setup({ ttl: 10_000 });
  const issued = issue(manager);
  assert.equal(issued.challenge.expiresAt, clock.t + clock.skew + 10_000);
  clock.skew -= 3_600_000;
  clock.t += 10_000;
  assert.equal(manager.resolve(resolveArgs(issued)).state, "expired");
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
  assert.throws(() => s2.manager.resolve(resolveArgs(i2)), wireValid);
  const s3 = setup();
  const i3 = issue(s3.manager);
  s3.manager.resolve(resolveArgs(i3));
  failOn(s3, "native");
  assert.throws(() => s3.manager.confirmNative({ challengeId: i3.challenge.challengeId, proof: i3.nativeProof ?? "", confirmed: true, windowId: WIN }), wireValid);
  const s4 = setup();
  const t4 = approve(s4.manager, issue(s4.manager));
  failOn(s4, "authorised");
  await assert.rejects(s4.manager.execute(t4, run, () => 1), (e: unknown) => wireValid(e) && internal(false)(e));
});

test("S2: when the action fails and the error audit also fails, the caller still learns the action ran", async () => {
  const s = setup();
  const token = approve(s.manager, issue(s.manager));
  s.failWhen((e) => e.outcome === "error");
  await assert.rejects(
    s.manager.execute(token, run, () => {
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
      manager.execute(token, run, () => {
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
  assert.throws(() => s.manager.resolve(resolveArgs(a, { decision: "deny" })), code("E_INTERNAL"));
  s.failWhen(undefined);
  assert.throws(() => s.manager.resolve(resolveArgs(a)), code("E_CONFLICT"), "an approve cannot follow the deny");

  const b = issue(s.manager);
  s.manager.resolve(resolveArgs(b));
  s.failWhen((e) => e.payload["decision"] === "cancel");
  assert.throws(() => s.manager.confirmNative({ challengeId: b.challenge.challengeId, proof: b.nativeProof ?? "", confirmed: false, windowId: WIN }), code("E_INTERNAL"));
  s.failWhen(undefined);
  assert.throws(() => s.manager.confirmNative({ challengeId: b.challenge.challengeId, proof: b.nativeProof ?? "", confirmed: true, windowId: WIN }), code("E_CONFLICT"), "a cancelled dialog cannot be re-confirmed");
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
  await assert.rejects(manager.execute(token, { ...run, target: "workspace:ws-1‮" }, () => 1), code("E_INVALID_ARGUMENT"));
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
    manager.execute(token, { ...run, args: retried }, () => {
      branchDeleted = retried.deleteBranch;
    }),
    code("E_POLICY_DENIED"),
  );
  assert.equal(branchDeleted, false);
  await assert.rejects(manager.execute(token, { ...run, args: { id: "ws-1", deleteBranch: false } }, () => 1), code("E_CONFLICT"), "burned: even the approved arguments cannot reuse it");
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
    await assert.rejects(manager.execute(token, { ...run, ...v }, () => void ran++), code("E_POLICY_DENIED"));
    assert.equal(ran, 0);
  }
});

test("B1: args and contract are validated: bounded plain objects only, contract shaped like name/version", () => {
  const { manager } = setup();
  const big = { blob: "x".repeat(20_000) };
  for (const bad of [{ args: big }, { args: [1] }, { args: null }, { args: "s" }, { args: { n: Number.NaN } }, { contract: "nope" }, { contract: "" }]) {
    assert.throws(() => issue(manager, bad as never), code("E_INVALID_ARGUMENT"));
  }
  assert.throws(() => manager.issue({ op: "worktree.discard", target: "t", contentDigest: CONTENT, actor: "user", windowId: WIN } as never), code("E_INVALID_ARGUMENT"), "contract and args are required");
  assert.equal(manager.outstanding(), 0);
});

test("B1: canonicalJson sorts keys at every depth and keeps array order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
});
