// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for review finding S7: the dev/test store is bounded per actor and sweeps in an amortised way.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryIdempotencyStore, type IdempotencyKey } from "../src/index.js";

const key = (actorId: string, k: string, workspaceId = ""): IdempotencyKey => ({ actorId, workspaceId, contract: "c", version: 1, method: "m", key: k });

test("S7: an actor at its cap evicts only its own completed entries, never another actor's", () => {
  const s = new MemoryIdempotencyStore({ maxPerActor: 3 });
  const victim = key("victim", "v1");
  assert.equal(s.begin(victim, "h").state, "new");
  s.complete(victim, { ok: 1 }, "conn-v");
  for (let i = 0; i < 20; i++) {
    const k = key("flooder", `f${i}`);
    assert.equal(s.begin(k, "h").state, "new");
    s.complete(k, i, "conn-f");
  }
  assert.deepEqual(s.begin(victim, "h"), { state: "replay", result: { ok: 1 }, origin: "conn-v" });
});

test("S7: in-progress entries are never evicted; a full actor answers exhausted", () => {
  const s = new MemoryIdempotencyStore({ maxPerActor: 2 });
  assert.equal(s.begin(key("a", "1"), "h").state, "new");
  assert.equal(s.begin(key("a", "2"), "h").state, "new");
  assert.equal(s.begin(key("a", "3"), "h").state, "exhausted");
  assert.equal(s.begin(key("a", "1"), "h").state, "in-progress");
  assert.equal(s.begin(key("b", "1"), "h").state, "new", "another actor is unaffected");
});

test("S7: the global cap also answers exhausted instead of evicting", () => {
  const s = new MemoryIdempotencyStore({ maxEntries: 2 });
  s.begin(key("a", "1"), "h");
  s.begin(key("b", "1"), "h");
  assert.equal(s.begin(key("c", "1"), "h").state, "exhausted");
});

test("S7: sweeping is amortised: expired entries go at most once per interval, not on every begin", () => {
  let now = 0;
  const s = new MemoryIdempotencyStore({ now: () => now, ttlMs: 1000, sweepEveryMs: 10_000 });
  for (let i = 0; i < 5; i++) {
    const k = key("a", `k${i}`);
    s.begin(k, "h");
    s.complete(k, i, "c");
  }
  now = 2000; // all expired, but the sweep interval has not passed
  s.begin(key("b", "x"), "h");
  assert.equal(s.size, 6, "no sweep yet");
  now = 11_000;
  s.begin(key("b", "y"), "h");
  assert.equal(s.size, 2, "swept once the interval passed");
});

test("S7: an expired entry is treated as absent on read even before a sweep; in-progress entries do not expire", () => {
  let now = 0;
  const s = new MemoryIdempotencyStore({ now: () => now, ttlMs: 1000, sweepEveryMs: 1e9 });
  const done = key("a", "d");
  s.begin(done, "h");
  s.complete(done, 1, "c");
  s.begin(key("a", "p"), "h");
  now = 5000;
  assert.equal(s.begin(done, "h").state, "new");
  assert.equal(s.begin(key("a", "p"), "h").state, "in-progress");
});

test("S7: the key is scoped by workspace, and a different payload hash conflicts", () => {
  const s = new MemoryIdempotencyStore();
  assert.equal(s.begin(key("a", "k", "ws-1"), "h1").state, "new");
  assert.equal(s.begin(key("a", "k", "ws-2"), "h1").state, "new");
  assert.equal(s.begin(key("a", "k", "ws-1"), "h2").state, "conflict");
});

test("S7: abandon frees an in-progress key but never a stored result", () => {
  const s = new MemoryIdempotencyStore();
  const a = key("a", "1");
  const b = key("a", "2");
  s.begin(a, "h");
  s.abandon(a);
  assert.equal(s.begin(a, "h").state, "new");
  s.begin(b, "h");
  s.complete(b, 1, "c");
  s.abandon(b);
  assert.equal(s.begin(b, "h").state, "replay");
});
