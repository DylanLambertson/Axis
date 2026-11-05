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

test("N1: a restart whose first clock reading is a month ahead does not free an unknown key", () => {
  const db = openDatabase(":memory:");
  const open = (now: () => number) => JournalIdempotencyStore.open(db, { audit: new AuditLog(db), redactor: new Redactor(), now });
  let t = 1_000_000;
  const first = open(() => t);
  first.begin(key("k"), "h");
  first.markUnknown(key("k")); // the daemon then dies
  let later = t + 30 * 24 * HOUR; // it restarts with its clock a month ahead
  const second = open(() => later);
  assert.equal(second.begin(key("k"), "h").state, "unknown", "the first reading after a restart is not trusted");
  later = t + 5 * 60_000; // the clock is corrected five minutes later
  assert.equal(second.begin(key("k"), "h").state, "unknown");
  t = later;
});

test("the default pending caps are a twentieth of the table per actor and half of that per workspace", () => {
  const s = make();
  const at = (w: string, i: number): string => s.begin(key(`k${i}`, { workspaceId: w }), "h").state;
  for (let i = 0; i < 250; i++) assert.equal(at("w1", i), "new");
  assert.equal(at("w1", 250), "exhausted");
  for (let i = 0; i < 250; i++) assert.equal(at("w2", i), "new");
  assert.equal(at("w3", 0), "exhausted");
});

test("N-b: a clock reading far ahead deletes nothing; the key stays unknown, and expires once the clock really got there", () => {
  let real = 1_000_000; // the monotonic clock
  let offset = 0; // the wall clock's error
  const s = make({ now: () => real + offset, monotonic: () => real });
  s.begin(key("k"), "h");
  s.markUnknown(key("k"));
  offset = 30 * 24 * HOUR; // a bad clock a month ahead
  for (let i = 0; i < 5; i++) {
    real += 60_000;
    assert.equal(s.begin(key("k"), "h").state, "unknown", "calls while the clock is wrong expire nothing");
  }
  offset = 0; // corrected
  real += 60_000;
  assert.equal(s.begin(key("k"), "h").state, "unknown");
  real += 8 * 24 * HOUR; // really 8 days later
  s.begin(key("tick"), "h");
  assert.equal(s.begin(key("k"), "h").state, "new", "after a real week it expires");
});

test("N1': a wrong boot clock stays wrong for minutes and several calls are made: the unknown key is kept", () => {
  const db = openDatabase(":memory:");
  let real = 1_000_000;
  let offset = 0;
  const open = () => JournalIdempotencyStore.open(db, { audit: new AuditLog(db), redactor: new Redactor(), now: () => real + offset, monotonic: () => real });
  const first = open();
  first.begin(key("k"), "h");
  first.markUnknown(key("k")); // the daemon dies
  real += 60_000;
  offset = 30 * 24 * HOUR; // it boots with its clock a month ahead
  real += 60_000;
  const second = open();
  for (const other of ["a", "b", "c"]) {
    real += 10_000;
    assert.equal(second.begin(key(other), "h").state, "new"); // the shell calls straight away
  }
  offset = 0; // corrected five minutes later
  real += 5 * 60_000;
  assert.equal(second.begin(key("k"), "h").state, "unknown");
});

test("N1': a real clock that is far ahead after a long downtime is accepted once it has held steady for an hour", () => {
  const db = openDatabase(":memory:");
  let real = 1_000_000;
  let skew = 0;
  const open = () => JournalIdempotencyStore.open(db, { audit: new AuditLog(db), redactor: new Redactor(), now: () => real + skew, monotonic: () => real });
  const first = open();
  first.begin(key("k"), "h");
  first.markUnknown(key("k"));
  skew = 30 * 24 * HOUR; // the machine was off for a month (the monotonic clock restarts with the process)
  const second = open();
  assert.equal(second.begin(key("k"), "h").state, "unknown", "not yet");
  for (let i = 0; i < 12; i++) {
    real += 6 * 60_000;
    second.begin(key("x"), "h");
  }
  real += 60_000;
  assert.equal(second.begin(key("k"), "h").state, "new", "the month has passed and the clock held steady for an hour");
});

test("N1': the clock seed uses the newest expiry too, so an honest restart of a long-lived row is not mistaken for a jump", () => {
  const db = openDatabase(":memory:");
  let real = 1_000_000;
  const open = () =>
    JournalIdempotencyStore.open(db, { audit: new AuditLog(db), redactor: new Redactor(), now: () => real, monotonic: () => real, ttlMs: HOUR, interruptedTtlMs: 2 * HOUR });
  const first = open();
  first.begin(key("k"), "h"); // created at 1 000 000
  real += 20 * HOUR;
  first.markUnknown(key("k")); // expires 2 h after this; its creation time is 20 h older
  real += 60_000;
  const second = open(); // an honest restart a minute later
  real += 2 * HOUR;
  assert.equal(second.begin(key("k"), "h").state, "new", "seeded from the expiry, the honest reading is trusted and the row has expired");
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
