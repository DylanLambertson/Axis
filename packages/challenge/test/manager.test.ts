// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { challengeSchema, errorSchema } from "@axis/protocol";
import { ChallengeError, challengeDigest, requestDigest, safeEqual, type ChallengeDigestInput, type RequestDigestInput } from "../src/index.js";
import { ARGS, CALLER, CHANGED, CONN, CONTENT, CONTRACT, WIN, approve, code, internal, issue, resolveArgs, run, setup, sha } from "./helpers.js";

test("issue returns a protocol-valid challenge with a 256-bit id bound to op, target and content", () => {
  const { manager } = setup();
  const issued = issue(manager);
  assert.doesNotThrow(() => challengeSchema.parse(issued.challenge));
  assert.equal(Buffer.from(issued.challenge.challengeId, "base64url").length, 32);
  assert.equal(issued.challenge.digest, digest());
  assert.equal(issued.challenge.nativeConfirmationRequired, true);
  assert.equal(issued.challenge.tier, 4);
  assert.equal(issued.challenge.expiresAt, 1_000_000 + 60_000);
  assert.ok(issued.nativeProof);
  assert.ok(!JSON.stringify(issued.challenge).includes(issued.nativeProof), "the renderer-visible challenge must not carry the native proof");
  assert.notEqual(issue(manager).challenge.challengeId, issued.challenge.challengeId);
});

const req = (over: Partial<RequestDigestInput> = {}) => requestDigest({ contract: CONTRACT, version: 1, method: "worktree.discard", payload: ARGS, ...over });
const digest = (over: Partial<ChallengeDigestInput> = {}) =>
  challengeDigest({ requestDigest: req(), target: "workspace:ws-1", contentDigest: CONTENT, ...over });

test("the digest changes with any of contract, version, method, arguments, target or content", () => {
  const base = digest();
  assert.notEqual(req(), req({ contract: "axis.terminals/1" }));
  assert.notEqual(req(), req({ version: 2 }));
  assert.notEqual(req(), req({ method: "worktree.remove" }));
  assert.notEqual(req(), req({ payload: { ...ARGS, deleteBranch: true } }));
  assert.notEqual(base, digest({ target: "workspace:ws-2" }));
  assert.notEqual(base, digest({ contentDigest: CHANGED }));
  assert.notEqual(req({ method: "a", contract: "b" }), req({ method: 'a","b', contract: "" }), "no delimiter ambiguity");
});

test("requestDigest matches its fixed vectors (shared spec: axis.request/1)", () => {
  // sha256 of the exact JSON text below; recomputed independently of the implementation.
  const text = '["axis.request/1","axis.worktrees/1",1,"remove","{\\"deleteBranch\\":false,\\"id\\":\\"ws-1\\"}"]';
  assert.equal(req({ method: "remove" }), sha(text));
  assert.equal(
    requestDigest({ contract: "c", version: 1, method: "m", payload: { b: [1, { z: null, y: true }], a: "x" } }),
    sha('["axis.request/1","c",1,"m","{\\"a\\":\\"x\\",\\"b\\":[1,{\\"y\\":true,\\"z\\":null}]}"]'),
  );
});

test("full flow: issue, resolve, native confirm, execute runs the action once and audits every phase", async () => {
  const { manager, events } = setup();
  const issued = issue(manager);
  const r = manager.resolve(...resolveArgs(issued));
  assert.deepEqual([r.state, r.nativeRequired], ["approved", true]);
  await assert.rejects(manager.consume(issued.challenge.challengeId, CALLER, run, () => 1), code("E_CONFLICT"), "not usable before the native confirmation");
  assert.ok(issued.nativeProof);
  const n = manager.confirmNative({ windowId: WIN }, { challengeId: issued.challenge.challengeId, proof: issued.nativeProof, confirmed: true });
  assert.equal(n.state, "approved");
  let ran = 0;
  const out = await manager.consume(issued.challenge.challengeId, CALLER, run, (c) => {
    ran++;
    assert.deepEqual(c, { method: "worktree.discard", target: "workspace:ws-1", requester: "user" });
    return "done";
  });
  assert.equal(out, "done");
  assert.equal(ran, 1);
  assert.deepEqual(events.map((e) => [e.action, e.payload["phase"], e.outcome]), [
    ["tier4.challenge", "issued", "success"],
    ["tier4.challenge", "resolve", "success"],
    ["tier4.execute", "execute", "denied"],
    ["tier4.challenge", "native", "success"],
    ["tier4.execute", "authorised", "success"],
    ["tier4.execute", "completed", "success"],
  ]);
  assert.equal(manager.outstanding(), 0);
});

test("a tier below 4 needs no native confirmation: resolve alone approves", async () => {
  const { manager } = setup();
  const issued = issue(manager, { tier: 3 });
  assert.equal(issued.challenge.nativeConfirmationRequired, false);
  assert.equal(issued.nativeProof, null);
  const r = manager.resolve(...resolveArgs(issued));
  assert.equal(r.nativeRequired, false);
  assert.equal(await manager.consume(issued.challenge.challengeId, CALLER, run, () => 1), 1);
});

test("replay: a resolved challenge cannot be resolved again, a spent token cannot run again", async () => {
  const { manager } = setup();
  const issued = issue(manager);
  const token = approve(manager, issued);
  assert.throws(() => manager.resolve(...resolveArgs(issued)), code("E_CONFLICT"));
  let ran = 0;
  await manager.consume(token, CALLER, run, () => void ran++);
  await assert.rejects(manager.consume(token, CALLER, run, () => void ran++), code("E_CONFLICT"));
  assert.equal(ran, 1);
});

test("a denied challenge stays denied", () => {
  const { manager } = setup();
  const issued = issue(manager);
  assert.equal(manager.resolve(...resolveArgs(issued, { decision: "deny" })).state, "denied");
  assert.throws(() => manager.resolve(...resolveArgs(issued)), code("E_CONFLICT"));
});

test("expiry (injected clock): challenge, native step and confirmation token all lapse", async () => {
  const a = setup({ ttl: 10_000, confirmTtl: 5_000 });
  const i1 = issue(a.manager);
  a.clock.t += 10_000;
  const r = a.manager.resolve(...resolveArgs(i1));
  assert.equal(r.state, "expired");

  const i2 = issue(a.manager);
  a.manager.resolve(...resolveArgs(i2));
  a.clock.t += 10_000;
  assert.ok(i2.nativeProof);
  assert.equal(a.manager.confirmNative({ windowId: WIN }, { challengeId: i2.challenge.challengeId, proof: i2.nativeProof, confirmed: true }).state, "expired");

  const i3 = issue(a.manager);
  const token = approve(a.manager, i3);
  a.clock.t += 5_000;
  let ran = 0;
  await assert.rejects(a.manager.consume(token, CALLER, run, () => void ran++), code("E_CONFLICT"));
  assert.equal(ran, 0);

  const i4 = issue(a.manager);
  const t4 = approve(a.manager, i4);
  a.clock.t += 4_999;
  await a.manager.consume(t4, CALLER, run, () => void ran++);
  assert.equal(ran, 1, "one millisecond before expiry still works");
});

test("only the user can resolve, only from the issuing window, and a refusal does not burn the challenge", async () => {
  const { manager, events } = setup();
  const issued = issue(manager, { actor: "agent:run-7" });
  for (const actor of ["agent:run-7", "agent:other", "daemon"]) {
    assert.throws(() => manager.resolve(...resolveArgs(issued, { actor })), code("E_POLICY_DENIED"));
  }
  assert.throws(() => manager.resolve(...resolveArgs(issued, { windowId: "window-2" })), code("E_POLICY_DENIED"));
  assert.equal(events.filter((e) => e.outcome === "denied").length, 4);
  const token = approve(manager, issued);
  assert.equal(await manager.consume(token, { ...CALLER, actor: "agent:run-7" }, run, () => "ok"), "ok");
});

test("a wrong native proof burns the challenge; a cancelled dialog denies it; native before resolve is refused", () => {
  const { manager } = setup();
  const a = issue(manager);
  assert.throws(() => manager.confirmNative({ windowId: WIN }, { challengeId: a.challenge.challengeId, proof: a.nativeProof ?? "", confirmed: true }), code("E_CONFLICT"));
  manager.resolve(...resolveArgs(a));
  assert.throws(() => manager.confirmNative({ windowId: WIN }, { challengeId: a.challenge.challengeId, proof: "guess", confirmed: true }), code("E_POLICY_DENIED"));
  assert.throws(() => manager.confirmNative({ windowId: WIN }, { challengeId: a.challenge.challengeId, proof: a.nativeProof ?? "", confirmed: true }), code("E_CONFLICT"));

  const b = issue(manager);
  manager.resolve(...resolveArgs(b));
  assert.ok(b.nativeProof);
  assert.equal(manager.confirmNative({ windowId: WIN }, { challengeId: b.challenge.challengeId, proof: b.nativeProof, confirmed: false }).state, "denied");
});

test("a stale or swapped digest echo is refused and burns the challenge", () => {
  const { manager } = setup();
  const issued = issue(manager);
  const other = issue(manager, { target: "workspace:ws-2" });
  assert.throws(() => manager.resolve(...resolveArgs(issued, { digest: other.challenge.digest })), code("E_CONFLICT"));
  assert.throws(() => manager.resolve(...resolveArgs(issued)), code("E_CONFLICT"));
});

test("a token for one operation or target does not authorise another, and the attempt burns it", async () => {
  const { manager } = setup();
  for (const wrong of [{ method: "worktree.remove" }, { target: "workspace:ws-2" }]) {
    const token = approve(manager, issue(manager));
    let ran = 0;
    await assert.rejects(manager.consume(token, CALLER, { ...run, ...wrong }, () => void ran++), code("E_POLICY_DENIED"));
    await assert.rejects(manager.consume(token, CALLER, run, () => void ran++), code("E_CONFLICT"));
    assert.equal(ran, 0);
  }
});

test("TOCTOU (G-24): content that changed after confirmation is refused with E_CONFLICT and the token is burned", async () => {
  const { manager, events } = setup();
  const token = approve(manager, issue(manager));
  let ran = 0;
  await assert.rejects(manager.consume(token, CALLER, { ...run, currentContentDigest: CHANGED }, () => void ran++), code("E_CONFLICT"));
  assert.equal(ran, 0);
  await assert.rejects(manager.consume(token, CALLER, run, () => void ran++), code("E_CONFLICT"), "even the original digest cannot reuse it");
  assert.equal(ran, 0);
  const exec = events.filter((e) => e.action === "tier4.execute");
  assert.equal(exec[0]?.payload["reason"], "content_changed");
  assert.equal(exec[0]?.outcome, "denied");
});

test("concurrency: two simultaneous resolves, only one wins", async () => {
  const { manager } = setup();
  const issued = issue(manager, { tier: 3 });
  const attempt = async () => manager.resolve(...resolveArgs(issued));
  const results = await Promise.allSettled([attempt(), attempt()]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
});

test("concurrency: two simultaneous executes of one token, the action runs once", async () => {
  const { manager } = setup();
  const token = approve(manager, issue(manager));
  let ran = 0;
  const slow = async () => {
    ran++;
    await new Promise((r) => setTimeout(r, 10));
  };
  const results = await Promise.allSettled([manager.consume(token, CALLER, run, slow), manager.consume(token, CALLER, run, slow)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(ran, 1);
});

test("outstanding challenges are bounded per actor and overall, and freed by deny and expiry", () => {
  const { manager, clock } = setup({ perActor: 3, total: 5, ttl: 10_000 });
  const mine = [1, 2, 3].map(() => issue(manager, { actor: "agent:a" }));
  assert.throws(() => issue(manager, { actor: "agent:a" }), code("E_BACKPRESSURE"));
  issue(manager, { actor: "agent:b" });
  issue(manager, { actor: "agent:c" });
  assert.throws(() => issue(manager, { actor: "agent:d" }), code("E_BACKPRESSURE"), "the overall bound holds too");

  const first = mine[0];
  assert.ok(first);
  manager.resolve(...resolveArgs(first, { decision: "deny" }));
  issue(manager, { actor: "agent:a" });
  assert.throws(() => issue(manager, { actor: "agent:a" }), code("E_BACKPRESSURE"));

  clock.t += 10_000;
  assert.equal(manager.outstanding(), 0);
  issue(manager, { actor: "agent:a" });
});

test("memory stays bounded: finished records are dropped after a grace period", () => {
  const { manager, clock } = setup({ ttl: 1_000 });
  const issued = issue(manager);
  clock.t += 1_000;
  assert.equal(manager.outstanding(), 0);
  clock.t += 2_001;
  issue(manager);
  assert.throws(() => manager.resolve(...resolveArgs(issued)), code("E_POLICY_DENIED"));
});

test("forged, malformed and foreign challenge ids are refused without running anything", async () => {
  const a = setup();
  const b = setup();
  const real = approve(a.manager, issue(a.manager));
  const foreign = approve(b.manager, issue(b.manager));
  let ran = 0;
  for (const f of ["A".repeat(43), foreign, "x".repeat(43)]) {
    await assert.rejects(a.manager.consume(f, CALLER, run, () => void ran++), code("E_POLICY_DENIED"));
  }
  for (const f of ["", "short", "has space ".repeat(5), null, undefined, 42, {}]) {
    await assert.rejects(a.manager.consume(f as never, CALLER, run, () => void ran++), code("E_INVALID_ARGUMENT"));
  }
  assert.equal(ran, 0);
  assert.equal(await a.manager.consume(real, CALLER, run, () => "still valid"), "still valid");
});

test("unknown challenge ids get the same refusal as a wrong caller (no existence oracle)", () => {
  const { manager } = setup();
  assert.throws(
    () => manager.resolve({ actor: "user", windowId: WIN }, { challengeId: "A".repeat(43), decision: "approve", digest: sha("x") }),
    code("E_POLICY_DENIED"),
  );
});

test("audit never contains a challenge id, native proof or content digest, and records requester identity", async () => {
  const { manager, events } = setup();
  const issued = issue(manager, { actor: "agent:run-9" });
  const token = approve(manager, issued);
  await manager.consume(token, { ...CALLER, actor: "agent:run-9" }, run, () => undefined);
  const dump = JSON.stringify(events);
  assert.ok(!dump.includes(issued.challenge.challengeId));
  assert.ok(!dump.includes(issued.nativeProof ?? "unreachable"));
  assert.ok(!dump.includes(CONTENT));
  assert.equal(events[0]?.actor, "agent:run-9");
  assert.equal(events[1]?.actor, "user");
  assert.equal(events.at(-1)?.actor, "daemon");
});

test("fail closed: if the audit sink fails, issue creates nothing and execute does not run the action", async () => {
  const s = setup();
  s.failWhen((e) => e.payload["phase"] === "issued");
  assert.throws(() => issue(s.manager), code("E_INTERNAL"));
  assert.equal(s.manager.outstanding(), 0);

  s.failWhen(undefined);
  const token = approve(s.manager, issue(s.manager));
  s.failWhen((e) => e.payload["phase"] === "authorised");
  let ran = 0;
  await assert.rejects(s.manager.consume(token, CALLER, run, () => void ran++), internal(false));
  assert.equal(ran, 0);
  s.failWhen(undefined);
  await assert.rejects(s.manager.consume(token, CALLER, run, () => void ran++), code("E_CONFLICT"), "the token was spent");
});

test("a failing action spends the token, is audited as an error and surfaces as E_INTERNAL with executed=true", async () => {
  const { manager, events } = setup();
  const token = approve(manager, issue(manager));
  await assert.rejects(
    manager.consume(token, CALLER, run, () => {
      throw new TypeError("boom /secret/path");
    }),
    (e: unknown) => internal(true)(e) && !(e as Error).message.includes("boom"),
  );
  assert.equal(events.at(-1)?.outcome, "error");
  assert.equal(events.at(-1)?.payload["errorName"], "TypeError");
  await assert.rejects(manager.consume(token, CALLER, run, () => 1), code("E_CONFLICT"));
});

test("a completion-audit failure after the action ran is reported as E_INTERNAL with executed=true", async () => {
  const s = setup();
  const token = approve(s.manager, issue(s.manager));
  s.failWhen((e) => e.payload["phase"] === "completed");
  await assert.rejects(
    s.manager.consume(token, CALLER, run, () => 1),
    (e: unknown) => e instanceof ChallengeError && e.code === "E_INTERNAL" && e.detail["executed"] === true,
  );
});

test("input validation: unknown keys, bad digest, bad actor, tier out of range; messages never echo values", () => {
  const { manager } = setup();
  const bad: Array<Record<string, unknown>> = [
    { contentDigest: "xyz" },
    { actor: "root" },
    { tier: 2 },
    { target: "a\nb" },
    { method: "Discard" },
    { extra: 1 },
  ];
  for (const b of bad) {
    assert.throws(() => manager.issue({ contract: CONTRACT, version: 1, method: "worktree.discard", target: "t", args: ARGS, contentDigest: CONTENT, actor: "user", connectionId: CONN, windowId: WIN, ...b } as never), code("E_INVALID_ARGUMENT"));
  }
  try {
    manager.issue({ contract: CONTRACT, version: 1, method: "worktree.discard", target: "t", args: ARGS, contentDigest: "SECRET-VALUE", actor: "user", connectionId: CONN, windowId: WIN });
    assert.fail("expected a throw");
  } catch (e) {
    assert.ok(e instanceof ChallengeError);
    assert.ok(!e.message.includes("SECRET-VALUE"));
  }
});

test("errors convert to the protocol wire shape", () => {
  const wire = new ChallengeError("E_CONFLICT", "changed", { state: "BURNED" }).toWire("corr-1");
  assert.doesNotThrow(() => errorSchema.parse(wire));
});

test("safeEqual compares by value, including different lengths", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", ""), true);
});

test("every error the manager raises is valid on the wire (E_APPROVAL_REQUIRED would need an attached challenge, so it is never used)", async () => {
  const { manager, clock } = setup({ ttl: 10_000, confirmTtl: 5_000 });
  const errors: unknown[] = [];
  const collect = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      errors.push(e);
    }
  };
  const issued = issue(manager);
  collect(() => manager.resolve(...resolveArgs(issued, { actor: "agent:x" })));
  collect(() => manager.resolve(...resolveArgs(issued, { digest: sha("other") })));
  collect(() => manager.resolve(...resolveArgs(issued)));
  collect(() => manager.resolve({ actor: "user", windowId: WIN }, { challengeId: "A".repeat(43), decision: "approve", digest: sha("x") }));
  collect(() => manager.issue({ nope: 1 } as never));
  const token = approve(manager, issue(manager));
  clock.t += 5_000;
  await manager.consume(token, CALLER, run, () => 1).catch((e: unknown) => errors.push(e));
  await manager.consume("A".repeat(43), CALLER, run, () => 1).catch((e: unknown) => errors.push(e));
  assert.ok(errors.length >= 7);
  for (const e of errors) {
    assert.ok(e instanceof ChallengeError);
    assert.notEqual(e.code, "E_APPROVAL_REQUIRED");
    assert.doesNotThrow(() => errorSchema.parse(e.toWire("corr")));
  }
});
