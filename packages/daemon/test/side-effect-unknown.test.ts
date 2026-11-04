// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Review fix S3: a side-effecting handler that returned must not have its key freed when the call then fails.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryIdempotencyStore, type IdempotencyKey, type IdempotencyStore } from "../src/index.js";
import { KEY1, KEY2, req, rig } from "./harness.js";

test("S3: a write whose response breaks its contract leaves the key unknown; the retry does not run the handler again", async (t) => {
  const r = rig({ idempotency: new MemoryIdempotencyStore() });
  t.after(() => r.cleanup());
  await r.handshake();
  let runs = 0;
  r.daemon.register("axis.test", 1, { write: () => (runs++, { n: "not a number" }) });
  r.send(req("w1", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  assert.equal((await r.inbox.response("w1")).error?.code, "E_INTERNAL");
  r.send(req("w2", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  const second = await r.inbox.response("w2");
  assert.equal(second.error?.code, "E_CONFLICT");
  assert.equal(second.error?.details?.reason, "outcome-unknown");
  assert.equal(runs, 1);
});

test("S3: a handler that throws before succeeding still frees the key (a bounded retry may run)", async (t) => {
  const r = rig({ idempotency: new MemoryIdempotencyStore() });
  t.after(() => r.cleanup());
  await r.handshake();
  let runs = 0;
  r.daemon.register("axis.test", 1, { write: (_c, p: { n: number }) => (++runs === 1 ? Promise.reject(new Error("nope")) : p) });
  r.send(req("e1", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  assert.equal((await r.inbox.response("e1")).ok, false);
  r.send(req("e2", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  assert.equal((await r.inbox.response("e2")).ok, true);
  assert.equal(runs, 2);
});

test("S3: the pipeline calls markUnknown, not abandon, after a returned side effect; abandon otherwise", async (t) => {
  const calls: string[] = [];
  const inner = new MemoryIdempotencyStore();
  const store: IdempotencyStore = {
    begin: (k: IdempotencyKey, h: string) => inner.begin(k, h),
    complete: (k, v, o) => inner.complete(k, v, o),
    abandon: (k) => (calls.push("abandon"), inner.abandon(k)),
    markUnknown: (k) => (calls.push("markUnknown"), inner.markUnknown(k)),
  };
  const r = rig({ idempotency: store });
  t.after(() => r.cleanup());
  await r.handshake();
  r.daemon.register("axis.test", 1, { write: (_c, p: { n: number }) => (p.n === 1 ? { n: "bad" } : Promise.reject(new Error("x"))) });
  r.send(req("m1", "write", { n: 1 }, { idempotencyKey: KEY1 }));
  await r.inbox.response("m1");
  r.send(req("m2", "write", { n: 2 }, { idempotencyKey: KEY2 }));
  await r.inbox.response("m2");
  assert.deepEqual(calls, ["markUnknown", "abandon"]);
});
