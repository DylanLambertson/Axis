// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Review fixes S1 and S2 and the nits: eviction, fairness, TTLs, clock and storage rules of the idempotency store.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { AuditLog, Redactor, acquireInstanceLock, openDatabase, type DatabaseSync } from "@axis/audit";
import { JournalIdempotencyStore, type IdempotencyStoreOptions, type StoreKey } from "../src/index.js";

const CHILD = fileURLToPath(new URL("./fixtures/idem-child.js", import.meta.url));
const key = (k: string, over: Partial<StoreKey> = {}): StoreKey => ({ actorId: "a", workspaceId: "w", contract: "axis.test", version: 1, method: "m", key: k, ...over });
function make(over: Partial<IdempotencyStoreOptions> = {}, db: DatabaseSync = openDatabase(":memory:")) {
  const audit = new AuditLog(db);
  return { db, audit, store: JournalIdempotencyStore.open(db, { audit, redactor: new Redactor(), ...over }) };
}
const done = (s: JournalIdempotencyStore, k: StoreKey, v: unknown = 1): void => {
  s.begin(k, "h");
  s.complete(k, v as never, "c");
};

test("S1: an unknown key is never evicted by its caller's later calls, and a full caller of unknown rows is exhausted", () => {
  let now = 0;
  const db = openDatabase(":memory:");
  make({ now: () => ++now, maxPerActor: 5 }, db).store.begin(key("destructive"), "h"); // the daemon dies mid-call
  const { store } = make({ now: () => ++now, maxPerActor: 5 }, db); // restart
  assert.equal(store.begin(key("destructive"), "h").state, "unknown");
  for (let i = 0; i < 50; i++) done(store, key(`f${i}`));
  assert.deepEqual(store.begin(key("destructive"), "h"), { state: "unknown", reason: "interrupted" });

  const full = make({ maxPerActor: 2 }).store;
  for (const n of ["1", "2"]) {
    full.begin(key(n), "h");
    full.markUnknown(key(n));
  }
  assert.deepEqual(full.begin(key("3"), "h"), { state: "exhausted" });
  assert.equal(full.begin(key("1"), "h").state, "unknown");
});

test("S1: a result-not-stored key survives the flood too", () => {
  const { store } = make({ maxPerActor: 3, maxResultBytes: 10 });
  store.begin(key("big"), "h");
  store.complete(key("big"), "x".repeat(50), "c");
  for (let i = 0; i < 20; i++) done(store, key(`f${i}`), i);
  assert.deepEqual(store.begin(key("big"), "h"), { state: "unknown", reason: "result-not-stored" });
});

test("S2: callers filling the row table cannot starve another caller; completed rows are evicted first", () => {
  let now = 0;
  const { store } = make({ now: () => ++now, maxEntries: 6, maxPerActor: 3 });
  for (const actorId of ["f1", "f2"]) for (let i = 0; i < 3; i++) done(store, key(`k${i}`, { actorId }));
  assert.deepEqual(store.begin(key("v1", { actorId: "victim" }), "h"), { state: "new" });
  store.complete(key("v1", { actorId: "victim" }), "mine", "c");
  assert.equal(store.begin(key("v1", { actorId: "victim" }), "h").state, "replay", "the victim's own row is kept");
  assert.equal(store.size, 6);
});

test("S2: the row table is exhausted only when nothing in it is completed", () => {
  const { store } = make({ maxEntries: 2 });
  store.begin(key("1", { actorId: "a" }), "h");
  store.begin(key("1", { actorId: "b" }), "h");
  assert.deepEqual(store.begin(key("1", { actorId: "c" }), "h"), { state: "exhausted" });
});

test("S2: one caller cannot use the whole result byte budget; another caller's results still replay", () => {
  let now = 0;
  const { store } = make({ now: () => ++now, maxTotalBytes: 800, maxShareBytes: 100 });
  for (let i = 0; i < 30; i++) done(store, key(`f${i}`, { actorId: "flood" }), "z".repeat(18)); // 20 bytes each
  for (let i = 0; i < 20; i++) done(store, key(`v${i}`, { actorId: "victim" }), "y".repeat(18));
  const states = (id: string, n: number) => Array.from({ length: n }, (_, i) => store.begin(key(`${id === "flood" ? "f" : "v"}${i}`, { actorId: id }), "h").state);
  assert.equal(states("flood", 30).filter((s) => s === "replay").length, 5, "the flooder keeps only its own share");
  assert.equal(states("victim", 20).filter((s) => s === "replay").length, 5);
});

test("S2: a result larger than a caller's share is not stored", () => {
  const { store } = make({ maxTotalBytes: 1000, maxShareBytes: 50 });
  done(store, key("k"), "q".repeat(100));
  assert.equal(store.begin(key("k"), "h").state, "unknown");
});

test("rulings: an interrupted key is remembered for 7 days, a result-not-stored one for the TTL", () => {
  let now = 1_000;
  const { store } = make({ now: () => now, maxResultBytes: 10 });
  store.begin(key("i"), "h");
  store.markUnknown(key("i"));
  store.begin(key("r"), "h");
  store.complete(key("r"), "x".repeat(50), "c");
  now += 25 * 3600_000;
  assert.equal(store.begin(key("i"), "h").state, "unknown");
  assert.equal(store.begin(key("r"), "h").state, "new", "result-not-stored forgets after 24 h");
  now += 7 * 24 * 3600_000;
  assert.equal(store.begin(key("i"), "h").state, "new", "after 7 days the interrupted key is forgotten");
});

test("markUnknown keeps a succeeded call's key unknown, and does nothing to a settled key", () => {
  const { store } = make();
  store.begin(key("k"), "h");
  store.markUnknown(key("k"));
  store.abandon(key("k"));
  assert.equal(store.begin(key("k"), "h").state, "unknown");
  done(store, key("c"), 5);
  store.markUnknown(key("c"));
  assert.equal(store.begin(key("c"), "h").state, "replay");
});

test("N1: complete refuses to run inside an outer transaction", () => {
  const { db, store } = make();
  store.begin(key("k"), "h");
  db.exec("BEGIN IMMEDIATE");
  assert.throws(() => store.complete(key("k"), 1, "c"), { code: "E_INTERNAL" });
  db.exec("ROLLBACK");
  store.abandon(key("k"));
  assert.equal(store.begin(key("k"), "h").state, "unknown", "a refused complete never frees the key");
});

test("N2: the stored text is the checked text: a getter cannot change it between the check and the store", () => {
  const { db, store } = make();
  let reads = 0;
  const sneaky = {
    get v(): string {
      return ++reads < 3 ? "fine" : "ghp_" + "Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm9Nb8";
    },
  };
  store.begin(key("k"), "h");
  store.complete(key("k"), sneaky as never, "c");
  assert.ok(!JSON.stringify(db.prepare("SELECT result FROM daemon_idempotency").all().map((r) => r.result)).includes("ghp_"));
});

test("N3: option and clock validation", () => {
  assert.throws(() => make({ sweepEveryMs: Number.NaN }), { code: "E_INVALID_ARGUMENT" });
  assert.throws(() => make({ now: () => 1.5 }), { code: "E_INTERNAL" });
});

test("N4: inside one boot the clock never runs backwards", () => {
  let now = 1_000;
  const { store } = make({ now: () => now, ttlMs: 100 });
  done(store, key("k"));
  now = 1_050;
  now = 0; // the clock jumps back
  assert.equal(store.begin(key("k"), "h").state, "replay");
  now = 1_100;
  assert.equal(store.begin(key("k"), "h").state, "new");
});

test("N5: strings over 16 384 characters are never replayable, small results are", () => {
  const { store } = make({ maxResultBytes: 1_000_000 });
  done(store, key("long"), "a".repeat(16_385));
  assert.equal(store.begin(key("long"), "h").state, "unknown");
  done(store, key("ok"), "a".repeat(16_000));
  assert.equal(store.begin(key("ok"), "h").state, "replay");
});

test("recover writes nothing for rows already unknown or settled", () => {
  const dir = mkdtempSync(join(tmpdir(), "axis-idem-"));
  try {
    const { audit, store, db } = make({}, openDatabase(join(dir, "j.db")));
    done(store, key("c"));
    const lock = acquireInstanceLock(dir);
    const before = audit.head()?.seq;
    assert.deepEqual(store.recover(lock), { interrupted: 0 });
    assert.equal(audit.head()?.seq, before);
    lock.release();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SIGKILL while large commits run back to back: every surviving key is intact or unknown, never half written", async () => {
  let total = 0;
  for (const delay of [5, 17, 41, 73]) {
    const dir = mkdtempSync(join(tmpdir(), "axis-idem-race-"));
    const dbPath = join(dir, "j.db");
    const child = spawn(process.execPath, [CHILD, dbPath, "commit-race"], { stdio: ["ignore", "pipe", "inherit"] });
    const exit = new Promise<string>((resolve) => child.on("exit", (code, signal) => resolve(signal ?? `code:${String(code)}`)));
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (d: Buffer) => d.toString().includes("READY") && resolve());
      void exit.then((how) => reject(new Error(`child exited before READY: ${how}`)));
    });
    await new Promise((r) => setTimeout(r, delay));
    child.kill("SIGKILL");
    assert.equal(await exit, "SIGKILL");
    try {
      const db = openDatabase(dbPath);
      assert.equal((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
      const { store } = make({}, db);
      let replayed = 0;
      for (let i = 0; i < 400; i++) {
        const r = store.begin(key(`k${i}`), `h${i}`);
        if (r.state === "replay") {
          replayed++;
          assert.deepEqual(r.result, { i, pad: "x".repeat(8_000) }, "a committed result is whole");
        } else {
          assert.ok(["new", "unknown", "exhausted"].includes(r.state), r.state);
        }
      }
      total += replayed;
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  assert.ok(total > 0, "at least one commit survived a kill, so the check above ran");
});

test("R3: one far-future clock reading does not pin expiries for the rest of the run", () => {
  let now = 1_000_000;
  const { store } = make({ now: () => now });
  now = 4_000_000_000_000; // a bad reading in the year 2096
  done(store, key("spike"));
  now = 1_000_000 + 1000; // the clock is right again
  store.begin(key("poke"), "h"); // any later call; the sweep brings the bad expiry back
  now += 60_001;
  store.begin(key("poke2"), "h");
  now += 8 * 24 * 3600_000;
  assert.equal(store.begin(key("spike"), "h").state, "new", "the row expires in the real timeline");
});

test("R4: at the row limit the caller holding the most rows loses its oldest, not the one with the biggest results", () => {
  let now = 0;
  const { store } = make({ now: () => ++now, maxEntries: 12, maxPerActor: 10 });
  for (let i = 0; i < 3; i++) done(store, key(`v${i}`, { actorId: "victim" }), "v".repeat(2000)); // few rows, big results
  for (let w = 0; w < 3; w++) for (let i = 0; i < 3; i++) done(store, key(`a${i}`, { actorId: "attacker", workspaceId: `w${w}` }), 1); // many rows, tiny
  for (let i = 0; i < 6; i++) store.begin(key(`n${i}`, { actorId: "new" }), "h");
  const kept = [0, 1, 2].map((i) => store.begin(key(`v${i}`, { actorId: "victim" }), "h").state);
  assert.deepEqual(kept, ["replay", "replay", "replay"]);
});

test("R6: a TTL above the maximum is refused at construction", () => {
  assert.throws(() => make({ ttlMs: Number.MAX_SAFE_INTEGER }), { code: "E_INVALID_ARGUMENT" });
  assert.throws(() => make({ interruptedTtlMs: 400 * 24 * 3600_000 }), { code: "E_INVALID_ARGUMENT" });
  assert.doesNotThrow(() => make({ ttlMs: 365 * 24 * 3600_000 }));
});

test("R7: a key marked unknown after the handler started says so, and a restart still says interrupted", () => {
  const db = openDatabase(":memory:");
  const a = make({}, db).store;
  a.begin(key("m"), "h");
  a.markUnknown(key("m"));
  assert.deepEqual(a.begin(key("m"), "h"), { state: "unknown", reason: "failed-after-start" });
  a.begin(key("r"), "h");
  const b = make({}, db).store;
  assert.deepEqual(b.begin(key("r"), "h"), { state: "unknown", reason: "interrupted" });
});
