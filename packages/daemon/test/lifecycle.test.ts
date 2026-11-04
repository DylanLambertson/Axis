// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for review findings B1, S2, S3, S4 and N2.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { MemoryIdempotencyStore, type IdempotencyKey, type IdempotencyStore } from "../src/index.js";
import { approveAndRun, fakeGate } from "./gate.js";
import { CONTRACT, KEY1, cid, hello, req, rig, verifier, type Rig } from "./harness.js";

async function ready(t: TestContext, options: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = rig(options);
  t.after(() => r.cleanup());
  await r.handshake();
  return r;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise<never>(() => undefined);
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}
async function welcome(c: { client: { postMessage(m: unknown): void }; inbox: Rig["inbox"] }): Promise<void> {
  c.client.postMessage(hello());
  await c.inbox.until((m): m is object => (m as { type?: string }).type === "welcome");
}

// ---- B1: slots and keys are held until the handler settles ----

test("B1a: timed-out handlers that are still running keep their in-flight slot", async (t) => {
  const r = await ready(t, { limits: { maxInFlight: 2 } });
  let running = 0;
  let peak = 0;
  r.daemon.register(CONTRACT, 1, { slow: () => (peak = Math.max(peak, ++running), never()) });
  for (let i = 0; i < 2; i++) {
    r.send(req(`p${i}`, "slow", {}, { timeoutMs: 1 }));
    assert.equal((await r.inbox.response(`p${i}`)).error?.code, "E_TIMEOUT");
  }
  for (let i = 2; i < 10; i++) {
    r.send(req(`p${i}`, "slow", {}, { timeoutMs: 1 }));
    assert.equal((await r.inbox.response(`p${i}`)).error?.code, "E_BACKPRESSURE", "the slots are still taken");
  }
  assert.equal(peak, 2);
});

test("B1b: a cancel answers at once but the slot stays taken while the handler runs", async (t) => {
  const r = await ready(t, { limits: { maxInFlight: 2 } });
  let running = 0;
  let peak = 0;
  r.daemon.register(CONTRACT, 1, { slow: () => (peak = Math.max(peak, ++running), never()) });
  for (let i = 0; i < 10; i++) {
    r.send(req(`c${i}`, "slow"));
    r.send({ v: 1, cancel: `c${i}` });
    const code = (await r.inbox.response(`c${i}`)).error?.code;
    assert.equal(code, i < 2 ? "E_CANCELLED" : "E_BACKPRESSURE");
  }
  assert.equal(peak, 2);
});

test("B1c: the slot frees when the handler settles, and a handler that honours the abort frees it promptly", async (t) => {
  const r = await ready(t, { limits: { maxInFlight: 1 } });
  r.daemon.register(CONTRACT, 1, {
    slow: (c) => new Promise((_, reject) => c.signal.addEventListener("abort", () => reject(new Error("stopped")))),
  });
  r.send(req("a", "slow", {}, { timeoutMs: 1 }));
  assert.equal((await r.inbox.response("a")).error?.code, "E_TIMEOUT");
  await wait(20);
  r.send(req("b", "slow", {}, { timeoutMs: 1 }));
  assert.equal((await r.inbox.response("b")).error?.code, "E_TIMEOUT", "admitted again, not backpressured");
});

test("B1d: close does not free the slots of running handlers; the daemon-wide orphan cap answers E_BACKPRESSURE", async (t) => {
  const r = await ready(t, { maxOrphanedHandlers: 2 });
  const gates = [deferred(), deferred()];
  let started = 0;
  r.daemon.register(CONTRACT, 1, { slow: () => gates[started++]?.promise ?? never() });
  r.send(req("o1", "slow"));
  r.send(req("o2", "slow"));
  await wait(20);
  r.client.close(); // peer goes away with two handlers running
  await wait(30);
  assert.equal(r.daemon.orphanedHandlers, 2);
  const next = r.connect("good#conn-2");
  await welcome(next);
  next.client.postMessage(req("n1", "slow"));
  assert.equal((await next.inbox.response("n1")).error?.code, "E_BACKPRESSURE");
  gates.forEach((g) => g.resolve());
  await wait(30);
  assert.equal(r.daemon.orphanedHandlers, 0);
  next.client.postMessage(req("n2", "slow"));
  next.client.postMessage({ v: 1, cancel: "n2" });
  assert.equal((await next.inbox.response("n2")).error?.code, "E_CANCELLED", "admitted once the orphans settled");
});

test("B1e: the idempotency key stays in-progress until the handler settles; a write that failed after its caller left stays unknown; success stores the result", async (t) => {
  const r = await ready(t);
  const gate = deferred<{ n: number }>();
  let runs = 0;
  r.daemon.register(CONTRACT, 1, { write: () => (++runs, gate.promise) });
  r.send(req("w1", "write", { n: 1 }, { idempotencyKey: KEY1, timeoutMs: 10 }));
  assert.equal((await r.inbox.response("w1")).error?.code, "E_TIMEOUT");
  r.send(req("w2", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  const busy = await r.inbox.response("w2");
  assert.equal(busy.error?.code, "E_CONFLICT");
  assert.equal(busy.error?.details?.["reason"], "in-progress");
  gate.reject(new Error("failed after the caller left")); // settles after the abort: the effect is uncertain, so the key is not freed
  await wait(30);
  r.send(req("w3", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  const after = await r.inbox.response("w3");
  assert.equal(after.error?.details?.["reason"], "outcome-unknown", "not wedged in progress, and not run again");
  assert.equal(runs, 1);
});

test("B1f: a success after the caller timed out is stored, and the retry replays it without running again", async (t) => {
  const r = await ready(t);
  const gate = deferred<{ n: number }>();
  let runs = 0;
  r.daemon.register(CONTRACT, 1, { write: () => (++runs, gate.promise) });
  r.send(req("s1", "write", { n: 7 }, { idempotencyKey: KEY1, timeoutMs: 10 }));
  assert.equal((await r.inbox.response("s1")).error?.code, "E_TIMEOUT");
  gate.resolve({ n: 7 });
  await wait(30);
  r.send(req("s2", "write", { n: 7 }, { idempotencyKey: KEY1 }));
  const res = await r.inbox.response("s2");
  assert.deepEqual([res.ok, res.result], [true, { n: 7 }]);
  assert.equal(runs, 1);
});

test("B1g: cancelling a keyed write leaves its key unknown once the handler settles; it is not run again", async (t) => {
  const r = await ready(t);
  const gate = deferred<{ n: number }>();
  let runs = 0;
  r.daemon.register(CONTRACT, 1, { write: (c) => (++runs, runs === 1 ? gate.promise.then(() => (c.signal.throwIfAborted(), { n: 1 })) : { n: 1 }) });
  r.send(req("k1", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  await wait(10);
  r.send({ v: 1, cancel: "k1" });
  assert.equal((await r.inbox.response("k1")).error?.code, "E_CANCELLED");
  gate.resolve({ n: 1 });
  await wait(30);
  r.send(req("k2", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  assert.equal((await r.inbox.response("k2")).error?.details?.["reason"], "outcome-unknown");
  assert.equal(runs, 1);
});

// ---- S2 ----

test("S2: a key whose begin() resolves after a timeout is not wedged in-progress", async (t) => {
  const inner = new MemoryIdempotencyStore();
  const store: IdempotencyStore = {
    begin: async (k: IdempotencyKey, h: string) => (await wait(50), inner.begin(k, h)),
    complete: (k, v, o) => inner.complete(k, v, o),
    abandon: (k) => inner.abandon(k),
    markUnknown: (k) => inner.markUnknown(k),
  };
  const r = await ready(t, { idempotency: store });
  r.daemon.register(CONTRACT, 1, { write: (_c, p: { n: number }) => p });
  r.send(req("w1", "write", { n: 1 }, { idempotencyKey: KEY1, timeoutMs: 10 }));
  assert.equal((await r.inbox.response("w1")).error?.code, "E_TIMEOUT");
  await wait(120);
  r.send(req("w2", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  const res = await r.inbox.response("w2", 2000);
  assert.equal(res.ok, true, `retry with the same key got ${res.error?.code}`);
});

// ---- S3: connection cap and verification ----

test("S3a: maxConnections holds when the verifier is async", async (t) => {
  const r = rig({ maxConnections: 1, identity: { verify: async (a) => (await wait(20), verifier.verify(a)) } });
  t.after(() => r.cleanup());
  const extra = [r.connect("good#conn-2"), r.connect("good#conn-3"), r.connect("good#conn-4")];
  await wait(100);
  assert.ok(r.daemon.connectionCount <= 1, `${r.daemon.connectionCount} live sessions with maxConnections 1`);
  for (const c of extra) assert.ok(await c.inbox.closedWithin());
});

test("S3b: a verifier that never settles ends in close, and the pending slot is released", async (t) => {
  let hang = true;
  const r = rig({
    maxConnections: 1,
    limits: { handshakeTimeoutMs: 40 },
    identity: { verify: (a) => (hang ? never() : verifier.verify(a)) },
  });
  t.after(() => r.cleanup());
  assert.ok(await r.inbox.closedWithin(1000), "the connection was closed when verification timed out");
  hang = false;
  const again = r.connect("good#conn-2");
  await welcome(again);
  assert.equal(r.daemon.connectionCount, 1);
});

test("S3c: closing during verification leaves no session behind", async (t) => {
  const gate = deferred();
  const r = rig({ identity: { verify: async (a) => (await gate.promise, verifier.verify(a)) } });
  t.after(() => r.cleanup());
  r.client.close();
  await wait(20);
  gate.resolve();
  await wait(20);
  assert.equal(r.daemon.connectionCount, 0);
});

// ---- S4: replay scoping and connection ids ----

test("S4a: the idempotency scope includes the workspace", async (t) => {
  const r = rig({ attestation: "good@ws-a" });
  t.after(() => r.cleanup());
  await r.handshake();
  let runs = 0;
  r.daemon.register(CONTRACT, 1, { write: (_c, p: { n: number }) => (++runs, p) });
  r.send(req("a1", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  assert.equal((await r.inbox.response("a1")).ok, true);
  const other = r.connect("good#conn-2@ws-b");
  await welcome(other);
  other.client.postMessage(req("b1", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  assert.equal((await other.inbox.response("b1")).ok, true);
  assert.equal(runs, 2, "another workspace cannot replay the first workspace's key");
});

test("S4b: a tier >= 3 replay from another connection needs its own approval; from the same connection it does not", async (t) => {
  const { gate, calls } = fakeGate();
  const r = await ready(t, { gate });
  let runs = 0;
  r.daemon.register(CONTRACT, 1, { danger: () => (runs++, { done: true }) });
  assert.equal((await r.inbox.response(await approveAndRun(r, "a", { id: "ws-1" }))).ok, true);
  r.send(req("a3", "danger", { id: "ws-1" }, { idempotencyKey: KEY1 }));
  assert.equal((await r.inbox.response("a3")).ok, true);
  assert.equal(calls.issue.length + calls.execute.length, 2, "same connection: the stored result is returned without another gate call");

  const other = r.connect("good#conn-2");
  await welcome(other);
  other.client.postMessage(req("b1", "danger", { id: "ws-1" }, { idempotencyKey: KEY1 }));
  assert.equal((await other.inbox.response("b1")).error?.code, "E_APPROVAL_REQUIRED", "no stored result without an approval of its own");
  const retry = await approveAndRun(r, "b", { id: "ws-1" }, undefined, other);
  const res = await other.inbox.response(retry);
  assert.deepEqual([res.ok, res.result], [true, { done: true }]);
  assert.equal(runs, 1, "the replay returned the stored result under a spent approval, without running the handler");
  assert.equal(calls.execute.at(-1)?.input.connectionId, cid("conn-2"));
});

test("S4c / RR-APR: a forged challenge id on another connection gets neither the stored tier 4 result nor a run", async (t) => {
  const { gate } = fakeGate();
  const r = await ready(t, { gate });
  let runs = 0;
  r.daemon.register(CONTRACT, 1, { danger: () => (runs++, { done: true }) });
  assert.equal((await r.inbox.response(await approveAndRun(r, "a", { id: "ws-1" }))).ok, true);
  const other = r.connect("good#conn-2");
  await welcome(other);
  other.client.postMessage(req("b1", "danger", { id: "ws-1", approval: { challengeId: "x".repeat(43) } }, { idempotencyKey: KEY1 }));
  const res = await other.inbox.response("b1");
  assert.equal(res.error?.code, "E_POLICY_DENIED");
  assert.equal(res.result, undefined, "the stored result is not disclosed");
  assert.equal(runs, 1);
});

test("S4d: a second live session reusing a connection id is refused", async (t) => {
  const r = await ready(t);
  const dup = r.connect("good"); // conn-1 again
  assert.ok(await dup.inbox.closedWithin());
  assert.equal(r.daemon.connectionCount, 1);
  assert.equal(r.inbox.closed, false, "the first session is unaffected");
});

// ---- N2: the gate gets an AbortSignal ----

test("N2: a cancel during a pending gate call aborts the signal the gate received", async (t) => {
  const seen = deferred<AbortSignal>();
  const { gate } = fakeGate();
  const r = await ready(t, {
    gate: {
      ...gate,
      issue: (i) => {
        seen.resolve(i.signal);
        return new Promise(() => undefined);
      },
    },
  });
  let ran = false;
  r.daemon.register(CONTRACT, 1, { danger: () => ((ran = true), { done: true }) });
  r.send(req("g1", "danger", { id: "ws-1" }, { idempotencyKey: KEY1 }));
  const signal = await seen.promise;
  assert.equal(signal.aborted, false);
  r.send({ v: 1, cancel: "g1" });
  assert.equal((await r.inbox.response("g1")).error?.code, "E_CANCELLED");
  assert.equal(signal.aborted, true);
  assert.equal(ran, false);
});
