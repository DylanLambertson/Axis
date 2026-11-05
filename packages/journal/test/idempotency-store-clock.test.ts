// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// A wall clock that is behind or ahead must never free an unknown key or shorten a replay window early; the size of the gate.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, Redactor, openDatabase } from "@axis/audit";
import { JournalIdempotencyStore, type IdempotencyStoreOptions, type StoreKey } from "../src/index.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const key = (k: string): StoreKey => ({ actorId: "a", workspaceId: "w", contract: "axis.test", version: 1, method: "m", key: k });

/** A real timeline (`real`, which the monotonic clock follows) and a wall clock that is off by `offset`. */
function rig(options: Partial<IdempotencyStoreOptions> = {}) {
  const db = openDatabase(":memory:");
  const c = { real: 60 * DAY, offset: 0 };
  const open = () =>
    JournalIdempotencyStore.open(db, { audit: new AuditLog(db), redactor: new Redactor(), now: () => c.real + c.offset, monotonic: () => c.real, ...options });
  return { c, open };
}

test("a clock 30 days BEHIND at boot frees no unknown key and shortens no replay window", () => {
  const { c, open } = rig();
  const first = open();
  first.begin(key("k1"), "h");
  first.markUnknown(key("k1"));
  first.begin(key("k2"), "h"); // the daemon dies with k2 in progress
  first.begin(key("c1"), "h");
  first.complete(key("c1"), 1, "c");
  c.real += MIN;
  c.offset = -30 * DAY; // restored snapshot, dead RTC battery
  const second = open();
  c.real += 10_000;
  assert.equal(second.begin(key("k2"), "h").state, "unknown", "converted while the clock is behind");
  c.real += 30 * MIN;
  c.offset = 0; // NTP corrects it
  assert.equal(second.begin(key("k1"), "h").state, "unknown");
  assert.equal(second.begin(key("k2"), "h").state, "unknown");
  assert.equal(second.begin(key("c1"), "h").state, "replay", "the completed key still replays");
});

test("keys written while the clock is behind are kept through the correction (it is confirmed only after an hour)", () => {
  const { c, open } = rig();
  c.offset = -30 * DAY;
  const s = open();
  s.begin(key("w1"), "h");
  s.markUnknown(key("w1")); // a timed-out write
  s.begin(key("w2"), "h");
  s.complete(key("w2"), 2, "c");
  c.real += 20 * MIN;
  s.begin(key("poke"), "h"); // a sweep while behind must not pull expiries back either
  c.real += 10 * MIN;
  c.offset = 0;
  assert.equal(s.begin(key("w1"), "h").state, "unknown");
  assert.equal(s.begin(key("w2"), "h").state, "replay");
  c.real += 40 * MIN; // still inside the hour the correction needs to be confirmed
  assert.equal(s.begin(key("w1"), "h").state, "unknown");
  assert.equal(s.begin(key("w2"), "h").state, "replay");
});

/** An unknown key made at t0 expiring 2 h later; the wall clock is `ahead` of real from 70 minutes on. */
function aheadState(ahead: number): string {
  const { c, open } = rig({ ttlMs: HOUR, interruptedTtlMs: 2 * HOUR });
  const s = open();
  s.begin(key("k"), "h");
  s.markUnknown(key("k"));
  c.real += 70 * MIN;
  c.offset = ahead;
  return s.begin(key("k"), "h").state;
}

test("gate size: a reading up to an hour ahead of uptime is trusted, one just past it is not", () => {
  assert.equal(aheadState(50 * MIN), "new", "50 minutes ahead is inside the allowance, so the row has expired");
  assert.equal(aheadState(59 * MIN), "new");
  assert.equal(aheadState(61 * MIN), "unknown", "61 minutes ahead is a jump: nothing expires");
  assert.equal(aheadState(90 * MIN), "unknown");
});

/** Readings every minute with the wall clock `30 days` ahead; returns the state after `holdMin` minutes. */
function heldFor(holdMin: number, bump?: { atMin: number; by: number }): string {
  const { c, open } = rig();
  const s = open();
  s.begin(key("k"), "h");
  s.markUnknown(key("k"));
  c.offset = 30 * DAY;
  let state = s.begin(key("x0"), "h").state;
  for (let m = 1; m <= holdMin; m++) {
    c.real += MIN;
    if (bump && m === bump.atMin) c.offset += bump.by;
    state = s.begin(key("k"), "h").state;
  }
  return state;
}

test("gate size: the offset must hold for the full hour before expiry follows it", () => {
  assert.equal(heldFor(59), "unknown", "59 minutes is not enough");
  assert.equal(heldFor(60), "new", "an hour is");
});

test("gate size: an offset that moves by more than 5 minutes starts the hour again; a small wobble does not", () => {
  assert.equal(heldFor(80, { atMin: 40, by: 10 * MIN }), "unknown", "a 10 minute move resets the hour");
  assert.equal(heldFor(60, { atMin: 40, by: 2 * MIN }), "new", "a 2 minute wobble does not");
});
