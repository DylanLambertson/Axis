// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { errorSchema } from "@axis/protocol";
import { ChallengeError, ChallengeManager, requestDigest } from "../src/index.js";
import { ARGS, CALLER, CONN, CONTENT, CONTRACT, WIN, approve, code, issue, resolveArgs, run, setup } from "./helpers.js";

// F1 (re-review): the shown contract, version and method are bound to the request digest.
test("F1: a precomputed digest of a different request cannot be issued under another method", () => {
  const { manager } = setup();
  const D = requestDigest({ contract: CONTRACT, version: 1, method: "remove", payload: { ...ARGS, deleteBranch: true } });
  assert.throws(() => issue(manager, { method: "list", requestDigest: D }), code("E_INVALID_ARGUMENT"));
});

test("F1: consume naming a different contract, version or method is refused and burns the approval", async () => {
  for (const other of [{ contract: "axis.terminals" }, { version: 7 }, { method: "kill" }]) {
    const { manager } = setup();
    const id = approve(manager, issue(manager));
    let ran = false;
    await assert.rejects(manager.consume(id, CALLER, { ...run, ...other }, () => void (ran = true)), code("E_POLICY_DENIED"));
    assert.equal(ran, false);
    await assert.rejects(manager.consume(id, CALLER, run, () => void (ran = true)), code("E_CONFLICT"), "burned");
    assert.equal(ran, false);
  }
});

// F2: withdraw.
test("F2: withdraw ends the challenge; resolve and consume get the uniform denial and the slots are free", async () => {
  const { manager } = setup({ perActor: 1 });
  const i = issue(manager);
  assert.throws(() => issue(manager), code("E_BACKPRESSURE"));
  manager.withdraw(i.challenge.challengeId, CALLER);
  assert.equal(manager.outstanding(), 0);
  assert.throws(() => manager.resolve(...resolveArgs(i)), code("E_POLICY_DENIED"));
  await assert.rejects(manager.consume(i.challenge.challengeId, CALLER, run, () => 1), code("E_POLICY_DENIED"));
  assert.doesNotThrow(() => issue(manager), "the actor slot is free again");
});

test("F2: withdraw also ends an approved challenge, and only its requester on its connection can", async () => {
  const { manager } = setup();
  const id = approve(manager, issue(manager));
  assert.throws(() => manager.withdraw(id, { actor: "agent:x", connectionId: CONN }), code("E_POLICY_DENIED"));
  assert.throws(() => manager.withdraw(id, { actor: "user", connectionId: "other" }), code("E_POLICY_DENIED"));
  manager.withdraw(id, CALLER);
  await assert.rejects(manager.consume(id, CALLER, run, () => 1), code("E_POLICY_DENIED"));
  assert.throws(() => manager.withdraw(id, CALLER), code("E_POLICY_DENIED"), "already gone");
});

test("F2: withdraw succeeds even if the audit sink is down", () => {
  const s = setup();
  const i = issue(s.manager);
  s.failWhen(() => true);
  s.manager.withdraw(i.challenge.challengeId, CALLER);
  assert.equal(s.manager.outstanding(), 0);
});

test("F2: withdrawConnection ends every live challenge of that connection and frees the window and total slots", () => {
  const { manager } = setup({ total: 3 });
  const a = issue(manager, { connectionId: "conn-a" });
  const b = issue(manager, { connectionId: "conn-a" });
  const c = issue(manager, { connectionId: "conn-b" });
  assert.throws(() => issue(manager), code("E_BACKPRESSURE"));
  assert.equal(manager.withdrawConnection("conn-a"), 2);
  assert.equal(manager.outstanding(undefined, WIN), 1);
  assert.throws(() => manager.resolve(...resolveArgs(a)), code("E_POLICY_DENIED"));
  assert.throws(() => manager.resolve(...resolveArgs(b)), code("E_POLICY_DENIED"));
  assert.equal(manager.resolve(...resolveArgs(c)).state, "approved");
  assert.equal(manager.withdrawConnection("conn-a"), 0);
  assert.doesNotThrow(() => issue(manager));
  assert.throws(() => manager.withdrawConnection(""), code("E_INVALID_ARGUMENT"));
});

// F3 (async sink).
test("F3: an async sink fails closed on the decision path and its rejection is never unhandled", async () => {
  let unhandled = 0;
  const h = () => void unhandled++;
  process.on("unhandledRejection", h);
  const m = new ChallengeManager({ audit: { append: (async () => { throw new Error("down"); }) as never } });
  const base = { contract: CONTRACT, version: 1, method: "worktree.discard", target: "workspace:ws-1", args: ARGS, contentDigest: CONTENT, actor: "user", connectionId: CONN, windowId: WIN };
  assert.throws(() => m.issue(base), code("E_INTERNAL"));
  assert.equal(m.outstanding(), 0, "nothing was stored");
  m.withdrawConnection(CONN); // best-effort paths swallow it as well
  await new Promise((r) => setTimeout(r, 20));
  process.off("unhandledRejection", h);
  assert.equal(unhandled, 0);
});

// NITs.
test("N-a: refusing an unknown id does the same audit work as refusing a wrong caller", async () => {
  const { manager, events } = setup();
  const id = approve(manager, issue(manager));
  const before = events.length;
  await assert.rejects(manager.consume(id, { actor: "agent:x", connectionId: CONN }, run, () => 1), code("E_POLICY_DENIED"));
  await assert.rejects(manager.consume("A".repeat(43), CALLER, run, () => 1), code("E_POLICY_DENIED"));
  assert.equal(events.length - before, 2);
  assert.ok(!JSON.stringify(events).includes("A".repeat(43)));
});

test("N-c: a monotonic clock that goes NaN fails closed and expires everything live", async () => {
  let bad = false;
  const m = new ChallengeManager({ audit: { append() {} }, monotonic: () => (bad ? Number.NaN : 1_000), now: () => 1_700_000_000_000 });
  const mk = () => m.issue({ contract: CONTRACT, version: 1, method: "worktree.discard", target: "workspace:ws-1", args: ARGS, contentDigest: CONTENT, actor: "user", connectionId: CONN, windowId: WIN, tier: 3 });
  const c = mk();
  m.resolve({ actor: "user", windowId: WIN }, { challengeId: c.challengeId, decision: "approve", digest: c.digest });
  bad = true;
  await assert.rejects(m.consume(c.challengeId, CALLER, run, () => 1), (e: unknown) => e instanceof ChallengeError && e.code === "E_INTERNAL");
  assert.throws(() => m.outstanding(), code("E_INTERNAL"));
  bad = false;
  await assert.rejects(m.consume(c.challengeId, CALLER, run, () => 1), code("E_CONFLICT"), "it did not survive");
});

test("N-d: an action that throws a protocol-shaped error keeps its code and message, with executed: true and nothing else", async () => {
  class Dirty extends Error {
    code = "E_CONFLICT";
    retryable = false;
    secret = "/home/u/.ssh";
    override cause = new Error("/etc/shadow");
    constructor() {
      super("The worktree has uncommitted changes");
    }
  }
  const { manager } = setup();
  const id = approve(manager, issue(manager));
  await assert.rejects(
    manager.consume(id, CALLER, run, () => {
      throw new Dirty();
    }),
    (e: unknown) => {
      assert.ok(e instanceof ChallengeError);
      assert.equal(e.code, "E_CONFLICT");
      assert.equal(e.message, "The worktree has uncommitted changes");
      assert.deepEqual(e.detail, { executed: true });
      assert.equal((e as { cause?: unknown }).cause, undefined);
      assert.doesNotThrow(() => errorSchema.parse(e.toWire("c")));
      assert.ok(!JSON.stringify(e.toWire("c")).includes("ssh"));
      return true;
    },
  );
});

test("N-d: E_APPROVAL_REQUIRED and malformed shapes from an action stay E_INTERNAL", async () => {
  for (const t of [Object.assign(new Error("x"), { code: "E_APPROVAL_REQUIRED", retryable: false }), Object.assign(new Error("x"), { code: "E_NOPE", retryable: false }), { code: "E_CONFLICT", message: "m", retryable: false }]) {
    const { manager } = setup();
    const id = approve(manager, issue(manager));
    await assert.rejects(manager.consume(id, CALLER, run, () => { throw t; }), (e: unknown) => e instanceof ChallengeError && e.code === "E_INTERNAL" && e.detail["executed"] === true);
  }
});

test("N-f: the args limit counts UTF-8 bytes", () => {
  const { manager } = setup();
  assert.doesNotThrow(() => issue(manager, { args: { s: "a".repeat(16_000) } }));
  // 6000 three-byte characters: 6000 code units but 18000 bytes.
  assert.throws(() => issue(manager, { args: { s: "中".repeat(6_000) } }), code("E_INVALID_ARGUMENT"));
});
