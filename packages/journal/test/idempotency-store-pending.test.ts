// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Review round 3: rows that cannot be evicted are capped per caller, and the clock rules for expiry.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, Redactor, openDatabase } from "@axis/audit";
import { JournalIdempotencyStore, type IdempotencyStoreOptions, type StoreKey } from "../src/index.js";

const HOUR = 3600_000;
const key = (k: string, over: Partial<StoreKey> = {}): StoreKey => ({ actorId: "a", workspaceId: "w", contract: "axis.test", version: 1, method: "m", key: k, ...over });
function make(over: Partial<IdempotencyStoreOptions> = {}) {
  const db = openDatabase(":memory:");
  return JournalIdempotencyStore.open(db, { audit: new AuditLog(db), redactor: new Redactor(), ...over });
}
/** A write that started and was cancelled: its key stays unknown and cannot be evicted. */
const cancelled = (s: JournalIdempotencyStore, k: StoreKey): string => {
  const first = s.begin(k, "h").state;
  if (first === "new") s.markUnknown(k);
  return first;
};

test("S1: one actor cancelling writes over several workspaces fills only its own cap; others still begin", () => {
  const s = make({ maxEntries: 20, maxPerActor: 10, maxPendingPerActor: 4, maxPendingPerWorkspace: 2 });
  const evil = (w: string, k: string): string => cancelled(s, key(k, { actorId: "evil", workspaceId: w }));
  assert.deepEqual(["1", "2"].map((k) => evil("w1", k)), ["new", "new"]);
  assert.equal(evil("w1", "3"), "exhausted", "the per-workspace cap");
  assert.deepEqual(["1", "2"].map((k) => evil("w2", k)), ["new", "new"]);
  assert.equal(evil("w3", "1"), "exhausted", "the per-actor cap holds across workspaces");
  assert.equal(s.begin(key("v1", { actorId: "victim", workspaceId: "w1" }), "h").state, "new");
  assert.equal(s.begin(key("v2", { actorId: "victim", workspaceId: "w3" }), "h").state, "new");
  assert.equal(s.begin(key("1", { actorId: "evil", workspaceId: "w1" }), "h").state, "unknown", "its existing keys still answer unknown");
});

test("S1: in-progress rows count, and a settled row frees room under the cap", () => {
  const s = make({ maxPendingPerActor: 2, maxPendingPerWorkspace: 2 });
  assert.equal(s.begin(key("1"), "h").state, "new");
  assert.equal(s.begin(key("2"), "h").state, "new");
  assert.equal(s.begin(key("3"), "h").state, "exhausted");
  s.complete(key("1"), 1, "c");
  assert.equal(s.begin(key("3"), "h").state, "new");
});

test("S1: once unevictable rows reach half the table, only actors that hold none can still begin", () => {
  const s = make({ maxEntries: 10, maxPerActor: 10, maxPendingPerActor: 3, maxPendingPerWorkspace: 3 });
  for (const k of ["1", "2", "3"]) cancelled(s, key(k, { actorId: "x" }));
  for (const k of ["1", "2"]) cancelled(s, key(k, { actorId: "y" }));
  assert.equal(s.begin(key("9", { actorId: "y" }), "h").state, "exhausted");
  assert.equal(s.begin(key("1", { actorId: "z" }), "h").state, "new");
});

test("the default pending caps are a twentieth of the table per actor and half of that per workspace", () => {
  const s = make();
  const at = (w: string, i: number): string => s.begin(key(`k${i}`, { workspaceId: w }), "h").state;
  for (let i = 0; i < 250; i++) assert.equal(at("w1", i), "new");
  assert.equal(at("w1", 250), "exhausted");
  for (let i = 0; i < 250; i++) assert.equal(at("w2", i), "new");
  assert.equal(at("w3", 0), "exhausted");
});

test("N-b: one clock reading far ahead deletes nothing; the key is still unknown, and expires once the clock agrees", () => {
  let now = 1_000_000;
  const s = make({ now: () => now });
  s.begin(key("k"), "h");
  s.markUnknown(key("k"));
  now += 30 * 24 * HOUR; // a bad reading a month ahead
  assert.equal(s.begin(key("k"), "h").state, "unknown", "the first reading ahead expires nothing");
  now = 1_000_000 + 2 * 60_000; // the clock is right again
  assert.equal(s.begin(key("k"), "h").state, "unknown");
  now += 8 * 24 * HOUR; // really 8 days later, reached in one step
  s.begin(key("tick"), "h");
  assert.equal(s.begin(key("k"), "h").state, "new", "a second reading that agrees lets it expire");
});

test("N-c: the expiry clamp follows the longer TTL, not the interrupted one", () => {
  let now = 1_000_000;
  const s = make({ now: () => now, ttlMs: 2 * 24 * HOUR, interruptedTtlMs: 24 * HOUR });
  s.begin(key("c"), "h");
  s.complete(key("c"), 7, "c");
  now += 61_000;
  s.begin(key("poke"), "h"); // a sweep
  now += 36 * HOUR - 61_000;
  s.begin(key("tick"), "h");
  assert.equal(s.begin(key("c"), "h").state, "replay", "a completed row keeps its own 2 day TTL");
});
