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
test("F2: withdraw ends the challenge: resolve and consume get the uniform denial", async () => {
  const { manager } = setup();
  const i = issue(manager);
  assert.deepEqual(manager.withdraw(i.challenge.challengeId, CALLER), { withdrawn: true });
  assert.equal(manager.outstanding(), 0, "nothing is left to prompt");
  assert.throws(() => manager.resolve(...resolveArgs(i)), code("E_POLICY_DENIED"));
  await assert.rejects(manager.consume(i.challenge.challengeId, CALLER, run, () => 1), code("E_POLICY_DENIED"));
});

// D1: withdraw must not be a way around the quotas.
test("D1: a withdrawn challenge keeps its slot until its original expiry, so issue/withdraw loops hit E_BACKPRESSURE", () => {
  const { manager, clock } = setup({ perActor: 2, ttl: 60_000 });
  const first = issue(manager);
  manager.withdraw(first.challenge.challengeId, CALLER);
  const second = issue(manager);
  manager.withdraw(second.challenge.challengeId, CALLER);
  let issued = 2;
  for (let n = 0; n < 500; n++) {
    try {
      manager.withdraw(issue(manager).challenge.challengeId, CALLER);
      issued++;
    } catch (e) {
      assert.ok(e instanceof ChallengeError && e.code === "E_BACKPRESSURE");
    }
  }
  assert.equal(issued, 2, "no prompt beyond the quota inside one TTL");
  clock.t += 60_001;
  assert.doesNotThrow(() => issue(manager), "the slots come back at the original expiry");
});

test("D1: a tombstone counts toward the window and total quotas, and is swept on schedule", () => {
  const { manager, clock } = setup({ total: 2 });
  const a = issue(manager);
  manager.withdraw(a.challenge.challengeId, CALLER);
  clock.t += 30_000;
  const b = issue(manager);
  manager.withdraw(b.challenge.challengeId, CALLER);
  assert.throws(() => issue(manager), code("E_BACKPRESSURE"));
  clock.t += 30_001; // a's original expiry has passed, b's has not
  const c = issue(manager);
  assert.throws(() => issue(manager), code("E_BACKPRESSURE"), "b still holds a slot");
  assert.ok(c.challenge.challengeId);
  clock.t += 60_000;
  assert.doesNotThrow(() => (issue(manager), issue(manager)), "every tombstone has been swept, so the whole quota is free");
});

test("F2: withdraw also ends an approved challenge, and only its requester on its connection can", async () => {
  const { manager } = setup();
  const id = approve(manager, issue(manager));
  assert.throws(() => manager.withdraw(id, { actor: "agent:x", connectionId: CONN }), code("E_POLICY_DENIED"));
  assert.throws(() => manager.withdraw(id, { actor: "user", connectionId: "other" }), code("E_POLICY_DENIED"));
  assert.deepEqual(manager.withdraw(id, CALLER), { withdrawn: true });
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

test("F2: withdrawConnection ends every live challenge of that connection", () => {
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
  assert.throws(() => issue(manager), code("E_BACKPRESSURE"), "the closed connection's tombstones still count");
  assert.throws(() => manager.withdrawConnection(""), code("E_INVALID_ARGUMENT"));
});

// N-j: withdraw after the approval was spent says so.
test("N-j: withdraw after the approval was spent, or after it ended, reports it instead of returning silently", async () => {
  const { manager } = setup();
  const id = approve(manager, issue(manager));
  await manager.consume(id, CALLER, run, () => 1);
  assert.deepEqual(manager.withdraw(id, CALLER), { withdrawn: false, reason: "spent" });
  const i = issue(manager);
  manager.resolve(...resolveArgs(i, { decision: "deny" }));
  assert.deepEqual(manager.withdraw(i.challenge.challengeId, CALLER), { withdrawn: false, reason: "ended" });
});

// F3 (async sink).
test("F3: an async sink fails closed on the decision path and its rejection is never unhandled", async () => {
  let unhandled = 0;
  const h = () => void unhandled++;
  process.on("unhandledRejection", h);
  const m = new ChallengeManager({ audit: { append: (async () => { throw new Error("down"); }) as never } });
  const base = { contract: CONTRACT, version: 1, method: "discard", target: "workspace:ws-1", args: ARGS, contentDigest: CONTENT, actor: "user", connectionId: CONN, windowId: WIN };
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
  const mk = () => m.issue({ contract: CONTRACT, version: 1, method: "discard", target: "workspace:ws-1", args: ARGS, contentDigest: CONTENT, actor: "user", connectionId: CONN, windowId: WIN, tier: 3 });
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

test("N-h: a hostile getter on the action's error cannot escape consume; it stays E_INTERNAL with executed: true", async () => {
  const hostile = {
    get code(): string {
      throw new Error("/secret/path");
    },
    get name(): string {
      throw new Error("/secret/path");
    },
  };
  const { manager, events } = setup();
  const id = approve(manager, issue(manager));
  await assert.rejects(
    manager.consume(id, CALLER, run, () => {
      throw hostile;
    }),
    (e: unknown) => e instanceof ChallengeError && e.code === "E_INTERNAL" && e.detail["executed"] === true && !e.message.includes("secret"),
  );
  assert.equal(events.at(-1)?.outcome, "error");
});

// The worktrees contract's methods, as @axis/protocol defines them: camelCase names must be accepted.
test("every axis.worktrees method name can be issued and consumed, and malformed names are refused", async () => {
  for (const method of ["list", "status", "create", "finalise", "remove", "restoreFromRunBase"]) {
    const { manager } = setup();
    const id = approve(manager, issue(manager, { method }));
    assert.equal(await manager.consume(id, CALLER, { ...run, method }, (c) => c.method), method);
  }
  const { manager } = setup();
  for (const bad of ["", "worktree.remove", "1remove", "restore_from_run_base", "a".repeat(65), "re move"]) {
    assert.throws(() => issue(manager, { method: bad }), code("E_INVALID_ARGUMENT"), bad);
  }
});

// The per-actor cap is per (actor, window): one window cannot lock the same user out of another.
test("a window that floods its own per-actor cap does not block the same actor in another window", () => {
  const { manager } = setup({ perActor: 2 });
  issue(manager, { windowId: "window-a" });
  const second = issue(manager, { windowId: "window-a" });
  assert.throws(() => issue(manager, { windowId: "window-a" }), code("E_BACKPRESSURE"));
  assert.doesNotThrow(() => issue(manager, { windowId: "window-b" }), "the other window still works");
  // Tombstones are keyed the same way: withdrawing in window-a does not free the slot, and does not touch window-b.
  manager.withdraw(second.challenge.challengeId, CALLER);
  assert.throws(() => issue(manager, { windowId: "window-a" }), code("E_BACKPRESSURE"));
  assert.doesNotThrow(() => issue(manager, { windowId: "window-b" }));
});

test("the overall per-actor backstop still bounds one actor across windows", () => {
  const { manager } = setup({ perActor: 2, perActorOverall: 3 });
  issue(manager, { windowId: "window-a" });
  issue(manager, { windowId: "window-b" });
  issue(manager, { windowId: "window-c" });
  assert.throws(() => issue(manager, { windowId: "window-d" }), code("E_BACKPRESSURE"));
  assert.doesNotThrow(() => issue(manager, { windowId: "window-d", actor: "agent:other" }), "another actor is unaffected");
});

// D1b: closing a connection must not reset the quota either.
test("D1b: a requester that reconnects in a loop cannot get past the prompt quota", () => {
  const { manager, clock } = setup({ perActor: 2 });
  let issued = 0;
  for (let n = 0; n < 100; n++) {
    const connectionId = `conn-${n}`;
    for (let k = 0; k < 2; k++) {
      try {
        issue(manager, { actor: "agent:loop", connectionId });
        issued++;
      } catch (e) {
        assert.ok(e instanceof ChallengeError && e.code === "E_BACKPRESSURE");
      }
    }
    manager.withdrawConnection(connectionId);
  }
  assert.equal(issued, 2, "only the first connection got any prompts through");
  clock.t += 60_001;
  assert.doesNotThrow(() => issue(manager, { actor: "agent:loop", connectionId: "conn-new" }), "the quota returns at the original expiry");
});

test("D1b: tombstones from closed connections are bounded by the total cap", () => {
  const { manager } = setup({ total: 4, perActor: 4 });
  let issued = 0;
  for (let n = 0; n < 50; n++) {
    try {
      issue(manager, { actor: `agent:a${n}`, connectionId: `c${n}`, windowId: `w${n}` });
      issued++;
    } catch (e) {
      assert.ok(e instanceof ChallengeError && e.code === "E_BACKPRESSURE");
    }
    manager.withdrawConnection(`c${n}`);
  }
  assert.equal(issued, 4);
});

test("a withdraw after the challenge expired, before any sweep, reports ended", () => {
  const { manager, clock } = setup({ ttl: 1_000 });
  const open = issue(manager);
  clock.t += 1_000;
  assert.deepEqual(manager.withdraw(open.challenge.challengeId, CALLER), { withdrawn: false, reason: "ended" });
  const confirmed = issue(manager, { tier: 3 });
  const id = approve(manager, confirmed);
  clock.t += 30_001; // the confirmation window (30 s) has run out; the challenge itself expired too
  assert.deepEqual(manager.withdraw(id, CALLER), { withdrawn: false, reason: "ended" });
});
