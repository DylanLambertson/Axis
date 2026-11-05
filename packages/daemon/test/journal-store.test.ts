// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The daemon pipeline against the real journal-backed store (the journal is a dev dependency of these tests only).
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { AuditLog, Redactor, openDatabase } from "@axis/audit";
import { JournalIdempotencyStore } from "@axis/journal";
import type { ContractRegistry, IdempotencyStore } from "../src/index.js";
import { DaemonError } from "../src/index.js";
import { approveAndRun, fakeGate } from "./gate.js";
import { KEY1, req, rig, testRegistry } from "./harness.js";

/** Compile-time check: the journal store is assignable to the daemon's interface (a drifting method fails the build). */
export const assignable = (s: JournalIdempotencyStore): IdempotencyStore => s;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function realStore(): JournalIdempotencyStore {
  const db = openDatabase(":memory:");
  return JournalIdempotencyStore.open(db, { audit: new AuditLog(db), redactor: new Redactor() });
}

async function ready(t: TestContext, options: Parameters<typeof rig>[0] = {}) {
  const r = rig({ idempotency: realStore(), ...options });
  t.after(() => r.cleanup());
  await r.handshake();
  return r;
}

/** A write that does its side effect, then honours the abort by rejecting: the shape of an aborted `git push`. */
function abortingWrite(runs: { n: number }) {
  return (c: { signal: AbortSignal }): Promise<never> =>
    new Promise((_, reject) => {
      runs.n++;
      c.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
}

test("R1: a tier-2 write that times out leaves its key unknown, so the retry does not run it again", async (t) => {
  const r = await ready(t);
  const runs = { n: 0 };
  r.daemon.register("axis.test", 1, { write: abortingWrite(runs) });
  r.send(req("t1", "write", { n: 1 }, { idempotencyKey: KEY1, timeoutMs: 30 }));
  assert.equal((await r.inbox.response("t1")).error?.code, "E_TIMEOUT");
  await wait(60);
  r.send(req("t2", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  const retry = await r.inbox.response("t2");
  assert.equal(retry.error?.code, "E_CONFLICT");
  assert.equal(retry.error?.details?.reason, "outcome-unknown");
  assert.equal(retry.error?.details?.cause, "failed-after-start");
  assert.equal(runs.n, 1);
});

test("R1: a cancelled tier-2 write leaves its key unknown", async (t) => {
  const r = await ready(t);
  const runs = { n: 0 };
  r.daemon.register("axis.test", 1, { write: abortingWrite(runs) });
  r.send(req("c1", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  await wait(20);
  r.send({ v: 1, cancel: "c1" });
  assert.equal((await r.inbox.response("c1")).error?.code, "E_CANCELLED");
  await wait(60);
  r.send(req("c2", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  assert.equal((await r.inbox.response("c2")).error?.details?.reason, "outcome-unknown");
  assert.equal(runs.n, 1);
});

/**
 * Hold a request after its key was taken and before its handler starts, cancel it, then let it go. `where` picks
 * the gap: inside `begin`, or inside the audit of the decision (the check at the top of `runAction`).
 */
for (const where of ["begin", "decision audit"] as const) {
  test(`R1: a cancel before the handler started (held in ${where}) frees the key, so the retry runs the write`, async (t) => {
    const real = realStore();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let hold = true;
    const once = async (): Promise<void> => {
      if (!hold) return;
      hold = false;
      await held;
    };
    const store: IdempotencyStore = {
      begin: async (k, h) => {
        const out = real.begin(k, h);
        if (where === "begin") await once();
        return out;
      },
      complete: (k, v, o) => real.complete(k, v, o),
      abandon: (k) => real.abandon(k),
      markUnknown: (k) => real.markUnknown(k),
    };
    const audit = { append: (): Promise<void> | void => (where === "decision audit" && real.size > 0 ? once() : undefined) };
    const r = await ready(t, { idempotency: store, audit });
    let runs = 0;
    r.daemon.register("axis.test", 1, { write: (_c, p: { n: number }) => (runs++, p) });
    r.send(req("b1", "write", { n: 1 }, { idempotencyKey: KEY1 }));
    await wait(20);
    r.send({ v: 1, cancel: "b1" });
    await wait(20);
    release();
    assert.equal((await r.inbox.response("b1")).error?.code, "E_CANCELLED");
    assert.equal(runs, 0, "the handler never started");
    r.send(req("b2", "write", { n: 1 }, { idempotencyKey: KEY1 }));
    assert.equal((await r.inbox.response("b2")).ok, true);
    assert.equal(runs, 1);
  });
}

test("R1: a handler that fails on its own (not aborted) frees the key", async (t) => {
  const r = await ready(t);
  let runs = 0;
  r.daemon.register("axis.test", 1, {
    write: (_c, p: { n: number }) => (++runs === 1 ? ((): never => { throw new DaemonError("E_NOT_FOUND", "nope"); })() : p),
  });
  r.send(req("f1", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  assert.equal((await r.inbox.response("f1")).error?.code, "E_NOT_FOUND");
  r.send(req("f2", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  assert.equal((await r.inbox.response("f2")).ok, true);
  assert.equal(runs, 2);
});

test("S3: tier 4, the approval gate fails after the action ran: a second approval does not run it again", async (t) => {
  const { gate } = fakeGate();
  const failing = { ...gate, execute: async (...a: Parameters<typeof gate.execute>) => (await gate.execute(...a), Promise.reject(new Error("audit write failed"))) } as typeof gate;
  const r = await ready(t, { gate: failing });
  let runs = 0;
  r.daemon.register("axis.test", 1, { danger: () => (runs++, { done: true }) });
  const first = await r.inbox.response(await approveAndRun(r, "g", { id: "ws-1" }));
  assert.equal(first.error?.code, "E_INTERNAL");
  await wait(20);
  r.send(req("g-3", "danger", { id: "ws-1" }, { idempotencyKey: KEY1 }));
  const retry = await r.inbox.response("g-3");
  assert.equal(retry.error?.details?.reason, "outcome-unknown");
  assert.equal(runs, 1);
});

test("R9: a tier-2 method declared read-only is still treated as side-effecting", async (t) => {
  const readFlag: ContractRegistry = {
    ...testRegistry,
    versions: (c) => testRegistry.versions(c),
    lookup: (c, v, m) => {
      const spec = testRegistry.lookup(c, v, m);
      return spec && m === "write" ? { ...spec, sideEffect: "read" } : spec;
    },
  };
  const r = await ready(t, { registry: readFlag });
  let runs = 0;
  r.daemon.register("axis.test", 1, { write: () => (runs++, { n: "not a number" }) });
  r.send(req("r1", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  assert.equal((await r.inbox.response("r1")).error?.code, "E_INTERNAL");
  r.send(req("r2", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  assert.equal((await r.inbox.response("r2")).error?.details?.reason, "outcome-unknown");
  assert.equal(runs, 1);
});

test("R2: a store without markUnknown fails closed: the key is never freed after a started handler", async (t) => {
  const calls: string[] = [];
  const bare = {
    begin: () => ({ state: "new" as const }),
    complete: () => calls.push("complete"),
    abandon: () => calls.push("abandon"),
  } as unknown as IdempotencyStore;
  const r = rig({ idempotency: bare });
  t.after(() => r.cleanup());
  await r.handshake();
  r.daemon.register("axis.test", 1, { write: () => ({ n: "bad" }) });
  r.send(req("s1", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  assert.equal((await r.inbox.response("s1")).error?.code, "E_INTERNAL");
  assert.deepEqual(calls, []);
});
