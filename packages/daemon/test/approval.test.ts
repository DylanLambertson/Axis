// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The pipeline owns the approval: issue, then execute (spend) with the handler inside the action.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ApprovalError, DaemonError, type ApprovalContentHook } from "../src/index.js";
import { approveAndRun, fakeGate, sha } from "./gate.js";
import { CONTRACT, KEY1, KEY2, hello, req, rig, type Rig } from "./harness.js";

async function ready(t: TestContext, options: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = rig(options);
  t.after(() => r.cleanup());
  await r.handshake();
  return r;
}
const KEY3 = "00000000-0000-4000-8000-000000000003";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function open(r: Rig, att: string) {
  const c = r.connect(att);
  c.client.postMessage(hello());
  await c.inbox.until((m): m is object => (m as { type?: string }).type === "welcome");
  return c;
}

/** A content hook over a mutable "file": the digest is taken under a lock that also covers the action. */
function fileHook(file: { content: string; target?: string }, log: string[] = []): ApprovalContentHook {
  return () => ({
    target: file.target ?? "workspace:ws-1",
    withLock: async (fn) => {
      log.push("lock");
      try {
        return await fn(sha(file.content));
      } finally {
        log.push("unlock");
      }
    },
  });
}

test("a content hook names the target, and the action runs inside its lock with the digest taken under it", async (t) => {
  const { gate, calls } = fakeGate();
  const file = { content: "v1" };
  const log: string[] = [];
  const r = await ready(t, { gate });
  r.daemon.register(CONTRACT, 1, { danger: () => (log.push("handler"), { done: true }) }, { content: { danger: fileHook(file, log) } });
  const id = await approveAndRun(r, "h", { id: "ws-1" });
  assert.equal((await r.inbox.response(id)).ok, true);
  assert.deepEqual(log, ["lock", "unlock", "lock", "handler", "unlock"], "issue reads the digest under the lock; execute runs the handler inside it");
  assert.deepEqual(calls.issue[0]?.content, { target: "workspace:ws-1", contentDigest: sha("v1") });
  assert.equal(calls.execute[0]?.content.contentDigest, sha("v1"));
});

test("a stale content digest is E_CONFLICT, the handler does not run, and the approval is spent", async (t) => {
  const { gate } = fakeGate();
  const file = { content: "v1" };
  const r = await ready(t, { gate });
  let runs = 0;
  r.daemon.register(CONTRACT, 1, { danger: () => (runs++, { done: true }) }, { content: { danger: fileHook(file) } });
  const id = await approveAndRun(r, "s", { id: "ws-1" }, () => void (file.content = "v2 (changed after the user looked)"));
  const res = await r.inbox.response(id);
  assert.equal(res.error?.code, "E_CONFLICT");
  assert.equal(runs, 0);
  assert.equal(r.events.at(-1)?.payload["reason"], "approval_conflict");
  r.send(req("s-3", "danger", { id: "ws-1", approval: { challengeId: "1".padStart(43, "A") } }, { idempotencyKey: KEY1 }));
  assert.equal((await r.inbox.response("s-3")).error?.code, "E_CONFLICT", "the same approval cannot be tried again");
});

test("a wrong content hook (a different target at execute than at issue) is refused", async (t) => {
  const { gate } = fakeGate();
  const file: { content: string; target?: string } = { content: "v1" };
  const r = await ready(t, { gate });
  r.daemon.register(CONTRACT, 1, { danger: () => assert.fail("must not run") }, { content: { danger: fileHook(file) } });
  const id = await approveAndRun(r, "w", { id: "ws-1" }, () => void (file.target = "workspace:other"));
  assert.equal((await r.inbox.response(id)).error?.code, "E_POLICY_DENIED");
});

test("a content hook that throws, or returns no lock, fails closed with an audit row", async (t) => {
  for (const hook of [(() => { throw new Error("db"); }) as ApprovalContentHook, (() => ({ target: "", withLock: () => undefined })) as unknown as ApprovalContentHook]) {
    const { gate } = fakeGate();
    const r = await ready(t, { gate });
    r.daemon.register(CONTRACT, 1, { danger: () => assert.fail("must not run") }, { content: { danger: hook } });
    r.send(req("c1", "danger", { id: "ws-1" }, { idempotencyKey: KEY1 }));
    assert.equal((await r.inbox.response("c1")).error?.code, "E_INTERNAL");
    assert.equal(r.events.at(-1)?.payload["reason"], "content_hook_error");
  }
});

test("D3-N1: a content hook with a bad target or digest is E_INTERNAL with a content_hook_error row and a local report, and nothing is issued", async (t) => {
  const good = "a".repeat(64);
  const hooks: Array<[string, (calls: number) => ApprovalContentHook]> = [
    ["empty target", () => () => ({ target: "", withLock: (fn) => fn(good) })],
    ["control characters in the target", () => () => ({ target: "workspace:\u0007x", withLock: (fn) => fn(good) })],
    ["target over 1024", () => () => ({ target: "w".repeat(1025), withLock: (fn) => fn(good) })],
    ["short digest", () => () => ({ target: "workspace:x", withLock: (fn) => fn("abc") })],
    ["uppercase digest", () => () => ({ target: "workspace:x", withLock: (fn) => fn("A".repeat(64)) })],
    ["non-string digest", () => () => ({ target: "workspace:x", withLock: (fn) => fn(undefined as never) })],
  ];
  for (const [name, make] of hooks) {
    const { gate, calls } = fakeGate();
    const r = await ready(t, { gate });
    r.daemon.register(CONTRACT, 1, { danger: () => assert.fail("must not run") }, { content: { danger: make(0) } });
    r.send(req("d3", "danger", { id: "ws-1" }, { idempotencyKey: KEY1 }));
    const res = await r.inbox.response("d3");
    assert.equal(res.error?.code, "E_INTERNAL", name);
    assert.equal(calls.issue.length, 0, name);
    assert.equal(r.events.at(-1)?.payload["reason"], "content_hook_error", name);
    assert.equal(r.internal.length, 1, name);
  }
});

test("D3-N1: a digest that goes bad between issue and execute is refused before the gate is asked to spend", async (t) => {
  const { gate, calls } = fakeGate();
  let digest = sha("v1");
  const r = await ready(t, { gate });
  r.daemon.register(CONTRACT, 1, { danger: () => assert.fail("must not run") }, { content: { danger: () => ({ target: "workspace:x", withLock: (fn) => fn(digest) }) } });
  const id = await approveAndRun(r, "b", { id: "ws-1" }, () => void (digest = "not hex"));
  assert.equal((await r.inbox.response(id)).error?.code, "E_INTERNAL");
  assert.equal(calls.execute.length, 0);
  assert.equal(r.events.at(-1)?.payload["reason"], "content_hook_error");
});

test("registering a content hook for a method without a handler throws", async (t) => {
  const r = await ready(t);
  assert.throws(() => r.daemon.register(CONTRACT, 1, { echo: () => 1 }, { content: { danger: () => ({ target: "x", withLock: (f) => f("d") }) } }), /no handler/);
});

test("a policy-raised tier needs the same approval: request:<digest> target, forged ids refused", async (t) => {
  const { gate, calls } = fakeGate();
  const r = await ready(t, { gate, policy: { evaluate: () => ({ effect: "allow", tier: 3 }) } });
  let ran = 0;
  r.daemon.register(CONTRACT, 1, { guarded: (_c, p: { text: string }) => (ran++, { text: p.text }) });
  r.send(req("p2", "guarded", { text: "x", approval: { challengeId: "z".repeat(43) } }));
  assert.equal((await r.inbox.response("p2")).error?.code, "E_POLICY_DENIED");
  assert.equal(ran, 0, "the handler never asked for an approval; the pipeline did");
  const id = await approveAndRun(r, "r", { text: "x", __method: "guarded" }, undefined, undefined, false);
  assert.equal((await r.inbox.response(id)).ok, true);
  assert.equal(ran, 1);
  assert.match(calls.issue.at(-1)?.content.target ?? "", /^request:[0-9a-f]{64}$/);
});

test("the action failing after the approval was spent frees the key and the approval stays spent", async (t) => {
  const { gate } = fakeGate();
  const r = await ready(t, { gate });
  let n = 0;
  r.daemon.register(CONTRACT, 1, { danger: () => (++n === 1 ? ((): never => { throw new DaemonError("E_NOT_FOUND", "No such workspace"); })() : { done: true }) });
  const id = await approveAndRun(r, "f", { id: "ws-1" });
  assert.equal((await r.inbox.response(id)).error?.code, "E_NOT_FOUND");
  r.send(req("f-3", "danger", { id: "ws-1", approval: { challengeId: "1".padStart(43, "A") } }, { idempotencyKey: KEY1 }));
  assert.equal((await r.inbox.response("f-3")).error?.code, "E_CONFLICT", "the spent approval cannot be reused");
  const again = await approveAndRun(r, "g", { id: "ws-1" });
  assert.equal((await r.inbox.response(again)).ok, true, "a fresh approval runs it: the key was freed");
});

test("an audit failure inside the spent approval is E_INTERNAL, frees the key and never returns a result", async (t) => {
  const { gate } = fakeGate();
  let failAudit = false;
  const r = await ready(t, { gate, audit: { append: () => { if (failAudit) throw new Error("disk"); } } });
  let runs = 0;
  r.daemon.register(CONTRACT, 1, { danger: () => (runs++, { done: true }) });
  const id = await approveAndRun(r, "a", { id: "ws-1" }, () => void (failAudit = true));
  assert.equal((await r.inbox.response(id)).error?.code, "E_INTERNAL");
  assert.equal(runs, 0);
});

test("a gate that answers without running the action is E_INTERNAL with an audit row (the invariant)", async (t) => {
  const { gate } = fakeGate();
  const r = await ready(t, { gate: { ...gate, execute: (async () => ({ ok: true, result: { done: true } })) as never } });
  r.daemon.register(CONTRACT, 1, { danger: () => assert.fail("must not run") });
  const id = await approveAndRun(r, "i", { id: "ws-1" });
  assert.equal((await r.inbox.response(id)).error?.code, "E_INTERNAL");
  assert.equal(r.events.at(-1)?.payload["reason"], "approval_not_executed");
});

test("a gate refusal maps to E_POLICY_DENIED or E_CONFLICT; any other gate error is E_INTERNAL", async (t) => {
  const cases: Array<[unknown, string]> = [
    [new ApprovalError("E_POLICY_DENIED"), "E_POLICY_DENIED"],
    [new ApprovalError("E_CONFLICT"), "E_CONFLICT"],
    [new Error("gate crashed"), "E_INTERNAL"],
  ];
  for (const [error, code] of cases) {
    const { gate } = fakeGate();
    const r = await ready(t, { gate: { ...gate, execute: () => Promise.reject(error) } });
    r.daemon.register(CONTRACT, 1, { danger: () => assert.fail("must not run") });
    const id = await approveAndRun(r, "m", { id: "ws-1" });
    assert.equal((await r.inbox.response(id)).error?.code, code);
  }
});

// ---- withdrawal ----

test("a cancel before the approval was spent withdraws it once; a timeout too; a spent approval is not withdrawn", async (t) => {
  const { gate, calls } = fakeGate();
  let hang = true;
  const r = await ready(t, { gate: { ...gate, execute: (i, ref, c, a) => (hang ? new Promise(() => undefined) : gate.execute(i, ref, c, a)) } });
  r.daemon.register(CONTRACT, 1, { danger: (c) => new Promise((res) => c.signal.addEventListener("abort", () => res({ done: true }))) });
  const first = await approveAndRun(r, "c", { id: "ws-1" });
  await wait(20);
  r.send({ v: 1, cancel: first });
  assert.equal((await r.inbox.response(first)).error?.code, "E_CANCELLED");
  await wait(20);
  assert.deepEqual(calls.withdraw.map((w) => w.challengeId), ["1".padStart(43, "A")]);

  r.send(req("t-1", "danger", { id: "ws-2" }, { idempotencyKey: KEY2 }));
  await r.inbox.response("t-1");
  r.send(req("t-2", "danger", { id: "ws-2", approval: { challengeId: "2".padStart(43, "A") } }, { idempotencyKey: KEY2, timeoutMs: 20 }));
  assert.equal((await r.inbox.response("t-2")).error?.code, "E_TIMEOUT");
  await wait(20);
  assert.equal(calls.withdraw.filter((w) => w.challengeId === "2".padStart(43, "A")).length, 1);

  hang = false;
  const spent = await approveAndRun(r, "s", { id: "ws-3", __key: KEY3 });
  await wait(20);
  r.send({ v: 1, cancel: spent });
  await r.inbox.response(spent);
  assert.equal(calls.withdraw.filter((w) => w.challengeId === "3".padStart(43, "A")).length, 0, "spent before the cancel: nothing to withdraw");
});

test("closing a connection withdraws its challenges once, and the gate sees one call per challenge", async (t) => {
  const { gate, calls, records } = fakeGate();
  const r = await ready(t, { gate });
  r.daemon.register(CONTRACT, 1, { danger: () => ({ done: true }) });
  r.send(req("w1", "danger", { id: "ws-1" }, { idempotencyKey: KEY1 }));
  await r.inbox.response("w1");
  const other = await open(r, "good#other-1");
  other.client.postMessage(req("w2", "danger", { id: "ws-9" }, { idempotencyKey: KEY1 }));
  await other.inbox.response("w2");
  r.client.close();
  await wait(40);
  assert.deepEqual(calls.withdrawConnection, ["conn-1".padEnd(22, "_")]);
  assert.equal(records.get("1".padStart(43, "A"))?.state, "withdrawn");
  assert.equal(records.get("2".padStart(43, "A"))?.state, "open", "another connection's challenge is untouched");
  assert.equal(calls.withdraw.length, 0, "no per-request withdrawals for a close");
});

test("a withdrawn challenge cannot be spent", async (t) => {
  const { gate, calls } = fakeGate();
  const r = await ready(t, { gate });
  r.daemon.register(CONTRACT, 1, { danger: () => assert.fail("must not run") });
  const id = await approveAndRun(r, "x", { id: "ws-1" }, () => void gate.withdraw?.("1".padStart(43, "A"), { actor: "user", connectionId: "conn-1".padEnd(22, "_") }));
  assert.equal((await r.inbox.response(id)).error?.code, "E_CONFLICT");
  assert.equal(calls.withdraw.length, 1);
});

test("a gate whose withdraw throws is reported locally and does not change the answer", async (t) => {
  const { gate } = fakeGate();
  const r = await ready(t, { gate: { ...gate, execute: () => new Promise(() => undefined), withdraw: () => { throw new Error("gone"); } } });
  r.daemon.register(CONTRACT, 1, { danger: () => assert.fail("must not run") });
  const id = await approveAndRun(r, "e", { id: "ws-1" });
  await wait(20);
  r.send({ v: 1, cancel: id });
  assert.equal((await r.inbox.response(id)).error?.code, "E_CANCELLED");
  await wait(20);
  assert.equal(r.internal.length, 1);
});
