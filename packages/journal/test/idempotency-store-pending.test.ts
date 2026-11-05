// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Review round 3: rows that cannot be evicted are capped per caller, and the clock rules for expiry.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, Redactor, openDatabase } from "@axis/audit";
import { JournalIdempotencyStore, type IdempotencyStoreOptions, type StoreKey } from "../src/index.js";

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

test("S1': ten actors holding half the table cannot lock out a legitimate actor with a timed-out write", () => {
  const s = make({ maxEntries: 1000, maxPerActor: 100, maxPendingPerActor: 50, maxPendingPerWorkspace: 50 });
  for (let a = 0; a < 10; a++) for (let i = 0; i < 50; i++) cancelled(s, key(`k${i}`, { actorId: `bad${a}` }));
  assert.equal(s.size, 500, "half the table is held by rows that cannot be evicted");
  assert.equal(cancelled(s, key("t1", { actorId: "legit" })), "new", "its write times out and its key stays unknown");
  assert.equal(s.begin(key("t2", { actorId: "legit" }), "h").state, "new", "and it can still write");
  for (let i = 3; i <= 16; i++) assert.equal(s.begin(key(`t${i}`, { actorId: "legit" }), "h").state, "new", "up to a floor of 16 in flight");
  assert.equal(s.begin(key("t17", { actorId: "legit" }), "h").state, "exhausted", "past the floor it is refused like the others");
  assert.equal(s.begin(key("x", { actorId: "bad0" }), "h").state, "exhausted");
  assert.equal(s.begin(key("n", { actorId: "newcomer" }), "h").state, "new");
});

test("the default pending caps are a twentieth of the table per actor and half of that per workspace", () => {
  const s = make();
  const at = (w: string, i: number): string => s.begin(key(`k${i}`, { workspaceId: w }), "h").state;
  for (let i = 0; i < 250; i++) assert.equal(at("w1", i), "new");
  assert.equal(at("w1", 250), "exhausted");
  for (let i = 0; i < 250; i++) assert.equal(at("w2", i), "new");
  assert.equal(at("w3", 0), "exhausted");
});
