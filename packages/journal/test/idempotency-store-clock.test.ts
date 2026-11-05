// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The store's clock is its own accumulated uptime: wall-clock changes, downtime and suspend never shorten or free a key.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { AuditLog, Redactor, acquireInstanceLock, openDatabase, type DatabaseSync } from "@axis/audit";
import { JournalIdempotencyStore, type IdempotencyStoreOptions, type StoreKey } from "../src/index.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const key = (k: string): StoreKey => ({ actorId: "a", workspaceId: "w", contract: "axis.test", version: 1, method: "m", key: k });

/** `c.up` is the process's monotonic clock. Downtime and suspend are time that passes without `c.up` moving. */
function rig(options: Partial<IdempotencyStoreOptions> = {}, db: DatabaseSync = openDatabase(":memory:")) {
  const c = { up: 5_000 };
  const open = () => JournalIdempotencyStore.open(db, { audit: new AuditLog(db), redactor: new Redactor(), monotonic: () => c.up, ...options });
  return { c, open, db };
}
const clockRow = (db: DatabaseSync): number => Number((db.prepare("SELECT trusted_ms AS t FROM daemon_idempotency_clock").get() as { t: number | bigint }).t);
const row = (db: DatabaseSync, k: string) =>
  db.prepare("SELECT created_at AS c, expires_at AS e FROM daemon_idempotency WHERE key = ?").get(k) as { c: number | bigint; e: number | bigint } | undefined;

test("an 8-day downtime then recover: the interrupted key is kept for its 7 days of uptime, not freed", () => {
  const dir = mkdtempSync(join(tmpdir(), "axis-idem-"));
  try {
    const { c, open, db } = rig({}, openDatabase(join(dir, "j.db")));
    open().begin(key("k"), "h"); // the daemon dies in the middle of this write
    // eight days pass with nothing running
    const second = open();
    const lock = acquireInstanceLock(dir);
    assert.deepEqual(second.recover(lock), { interrupted: 1 });
    c.up += HOUR;
    assert.equal(second.begin(key("k"), "h").state, "unknown", "the retry is refused, the write does not run again");
    c.up += 6 * DAY;
    assert.equal(second.begin(key("k"), "h").state, "unknown");
    c.up += 2 * DAY;
    assert.equal(second.begin(key("k"), "h").state, "new", "after 7 days of uptime it expires");
    lock.release();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an 8-day suspend then markUnknown: the key keeps its full 7 days", () => {
  const { c, open } = rig();
  const s = open();
  s.begin(key("k"), "h");
  // the machine is suspended for eight days; the monotonic clock does not move
  s.markUnknown(key("k"));
  c.up += 6 * DAY;
  assert.equal(s.begin(key("k"), "h").state, "unknown");
  c.up += 2 * DAY;
  assert.equal(s.begin(key("k"), "h").state, "new");
});

test("a 2-day suspend then complete: the result replays for its full 24 h", () => {
  const { c, open } = rig();
  const s = open();
  s.begin(key("k"), "h");
  // suspended for two days
  s.complete(key("k"), { done: true }, "c");
  c.up += 23 * HOUR;
  assert.equal(s.begin(key("k"), "h").state, "replay");
  c.up += 2 * HOUR;
  assert.equal(s.begin(key("k"), "h").state, "new");
});

for (const [name, wall] of [["+30 days ahead", 30 * DAY], ["-30 days behind", -30 * DAY], ["10 years ahead", 3650 * DAY]] as const) {
  test(`the wall clock is never read: ${name} at boot and later changes nothing`, (t) => {
    const real = Date.now();
    t.mock.method(Date, "now", () => real + wall);
    const { c, open, db } = rig();
    const s = open();
    s.begin(key("u"), "h");
    s.markUnknown(key("u"));
    s.begin(key("d"), "h");
    s.complete(key("d"), 1, "c");
    mock.restoreAll();
    t.mock.method(Date, "now", () => real); // corrected a moment later
    c.up += 23 * HOUR;
    assert.equal(s.begin(key("d"), "h").state, "replay");
    c.up += 2 * HOUR;
    assert.equal(s.begin(key("d"), "h").state, "new");
    c.up += 5 * DAY;
    assert.equal(s.begin(key("u"), "h").state, "unknown");
    c.up += 2 * DAY;
    assert.equal(s.begin(key("u"), "h").state, "new");
    assert.ok(clockRow(db) < 10 * DAY, "the saved counter is uptime, not a wall time");
  });
}

test("the counter accumulates across restarts and is saved with each write", () => {
  const { c, open, db } = rig();
  const first = open();
  first.begin(key("k"), "h");
  first.complete(key("k"), 1, "c"); // created at 0, expires at 24 h
  c.up += 10 * HOUR;
  first.begin(key("x"), "h"); // saves 10 h; then the process dies without a shutdown hook
  assert.equal(clockRow(db), 10 * HOUR);
  c.up += 500 * DAY; // downtime
  const second = open();
  c.up += 13 * HOUR;
  assert.equal(second.begin(key("k"), "h").state, "replay", "23 h of uptime in total");
  c.up += 2 * HOUR;
  assert.equal(second.begin(key("k"), "h").state, "new", "25 h in total");
  assert.equal(clockRow(db), 25 * HOUR);
});

test("created_at and expires_at come from the counter, and no expiry is more than the longest TTL past it", () => {
  const { c, open, db } = rig();
  const s = open();
  c.up += HOUR;
  s.begin(key("a"), "h");
  s.complete(key("a"), 1, "c");
  s.begin(key("b"), "h");
  s.markUnknown(key("b"));
  assert.deepEqual([Number(row(db, "a")?.c), Number(row(db, "a")?.e)], [HOUR, HOUR + DAY]);
  assert.deepEqual([Number(row(db, "b")?.c), Number(row(db, "b")?.e)], [HOUR, HOUR + 7 * DAY]);
  const max = Number((db.prepare("SELECT MAX(expires_at) AS m FROM daemon_idempotency").get() as { m: number | bigint }).m);
  assert.ok(max - clockRow(db) <= 7 * DAY);
});

test("the counter never goes backwards, and a bad monotonic source is refused", () => {
  const { c, open } = rig();
  c.up += 4 * DAY;
  const s = open();
  s.begin(key("k"), "h");
  s.complete(key("k"), 1, "c");
  c.up -= 3 * DAY; // a broken source
  assert.equal(s.begin(key("k"), "h").state, "replay");
  assert.throws(() => rig({ monotonic: () => -1 }).open(), { code: "E_INTERNAL" });
});
