// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// A keyed write that had already started when shutdown began: its key ends up unknown, never free, never re-run.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { MemoryIdempotencyStore } from "../src/index.js";
import { CONTRACT, KEY1, req, rig, type Rig } from "./harness.js";

async function ready(t: TestContext, options: Parameters<typeof rig>[0]): Promise<Rig> {
  const r = rig(options);
  t.after(() => r.cleanup());
  await r.handshake();
  return r;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WRITE = req("w", "write", { n: 1 }, { idempotencyKey: KEY1 });

/** The same store behind a fresh daemon: what a retry sees after the first one shut down. */
async function retry(t: TestContext, store: MemoryIdempotencyStore, runs: { n: number }) {
  const r = await ready(t, { idempotency: store });
  r.daemon.register(CONTRACT, 1, { write: () => (runs.n++, { n: 1 }) });
  r.send({ ...WRITE, id: "retry" });
  return r.inbox.response("retry");
}

test("K1: a started write cancelled by shutdown leaves its key unknown; a retry is refused and the handler never runs twice", async (t) => {
  const store = new MemoryIdempotencyStore();
  const r = await ready(t, { idempotency: store, shutdown: { graceMs: 30, cancelSettleMs: 500 } });
  const runs = { n: 0 };
  r.daemon.register(CONTRACT, 1, {
    write: (c) =>
      new Promise((_, reject) => {
        runs.n++;
        c.signal.addEventListener("abort", () => reject(new Error("stopped")));
      }),
  });
  r.send(WRITE);
  await wait(10);
  const res = await r.daemon.shutdown("SIGTERM");
  assert.equal(res.cancelled, 1);
  assert.equal(res.unsettled, 0, "the handler settled, so the drain is complete");
  assert.equal((await r.inbox.response("w")).error?.code, "E_CANCELLED");
  const again = await retry(t, store, runs);
  assert.equal(again.error?.code, "E_CONFLICT");
  assert.equal(again.error?.details?.["reason"], "outcome-unknown");
  assert.equal(runs.n, 1, "the write ran once and was not re-run");
});

test("K2: a started write whose handler ignores cancellation keeps its key in progress, never free, and shutdown still drains what it can", async (t) => {
  const store = new MemoryIdempotencyStore();
  const r = await ready(t, { idempotency: store, shutdown: { graceMs: 20, cancelSettleMs: 20 } });
  const runs = { n: 0 };
  let release!: () => void;
  r.daemon.register(CONTRACT, 1, { write: () => (runs.n++, new Promise((res) => (release = () => res({ n: 1 })))) });
  r.send(WRITE);
  await wait(10);
  const res = await r.daemon.shutdown("SIGTERM");
  assert.equal(res.unsettled, 1);
  const again = await retry(t, store, runs);
  assert.equal(again.error?.code, "E_CONFLICT", "the key is held, not free");
  assert.equal(runs.n, 1);
  release();
  await wait(20);
  const after = await retry(t, store, runs);
  assert.equal(runs.n, 1, "still not re-run once the handler finally settled");
  assert.notEqual(after.error?.code, "E_INTERNAL");
});

test("K3: a keyed write refused before its handler started leaves its key free, so the retry runs it", async (t) => {
  const store = new MemoryIdempotencyStore();
  let parked!: () => void;
  const park = new Promise<void>((res) => (parked = res));
  let first = true;
  const r = await ready(t, { idempotency: store, audit: { append: () => (first ? ((first = false), park) : undefined) } });
  const runs = { n: 0 };
  r.daemon.register(CONTRACT, 1, { write: () => (runs.n++, { n: 1 }) });
  r.send(WRITE);
  await wait(10);
  const done = r.daemon.shutdown("SIGTERM");
  parked();
  assert.equal((await r.inbox.response("w")).error?.code, "E_UNAVAILABLE");
  await done;
  assert.equal(runs.n, 0);
  assert.equal((await retry(t, store, runs)).ok, true);
  assert.equal(runs.n, 1);
});
