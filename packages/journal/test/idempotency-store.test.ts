// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
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
const key = (k: string, over: Partial<StoreKey> = {}): StoreKey => ({
  actorId: "a",
  workspaceId: "w",
  contract: "axis.test",
  version: 1,
  method: "m",
  key: k,
  ...over,
});

function make(db: DatabaseSync = openDatabase(":memory:"), over: Partial<IdempotencyStoreOptions> = {}) {
  const audit = new AuditLog(db);
  const store = JournalIdempotencyStore.open(db, { audit, redactor: new Redactor(), ...over });
  return { db, audit, store };
}

test("a key stays in-progress until it settles, then replays the same result and origin", () => {
  const { store } = make();
  assert.deepEqual(store.begin(key("k"), "h"), { state: "new" });
  assert.deepEqual(store.begin(key("k"), "h"), { state: "in-progress" });
  store.complete(key("k"), { n: 1, list: ["x"] }, "conn-1");
  assert.deepEqual(store.begin(key("k"), "h"), { state: "replay", result: { n: 1, list: ["x"] }, origin: "conn-1" });
});

test("a reused key with a different request hash is a conflict, in progress or settled", () => {
  const { store } = make();
  store.begin(key("k"), "h1");
  assert.deepEqual(store.begin(key("k"), "h2"), { state: "conflict" });
  store.complete(key("k"), 1, "c");
  assert.deepEqual(store.begin(key("k"), "h2"), { state: "conflict" });
});

test("keys are scoped by actor, workspace, contract, version and method", () => {
  const { store } = make();
  store.begin(key("k"), "h");
  store.complete(key("k"), "mine", "c");
  for (const other of [{ actorId: "b" }, { workspaceId: "w2" }, { contract: "axis.other" }, { version: 2 }, { method: "n" }]) {
    assert.deepEqual(store.begin(key("k", other), "h"), { state: "new" }, JSON.stringify(other));
  }
});

test("abandon frees an in-progress key but never touches a settled one", () => {
  const { store } = make();
  store.begin(key("k"), "h");
  store.abandon(key("k"));
  assert.deepEqual(store.begin(key("k"), "h"), { state: "new" });
  store.complete(key("k"), 1, "c");
  store.abandon(key("k"));
  assert.equal(store.begin(key("k"), "h").state, "replay");
});

test("a result is kept only if redaction leaves it unchanged: secrets are never persisted", () => {
  const { db, store } = make();
  const leaked = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  store.begin(key("k"), "h");
  store.complete(key("k"), { token: leaked, note: `Bearer ${leaked}` }, "c");
  assert.deepEqual(store.begin(key("k"), "h"), { state: "unknown", reason: "result-not-stored" });
  const rows = db.prepare("SELECT result FROM daemon_idempotency").all() as Array<{ result: string | null }>;
  assert.deepEqual(rows.map((r) => r.result), [null]);
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM daemon_idempotency").all()).includes(leaked));
});

test("a registered secret in a result is withheld too", () => {
  const redactor = new Redactor();
  redactor.registerSecret("correct-horse-battery-staple-9");
  const { store } = make(openDatabase(":memory:"), { redactor });
  store.begin(key("k"), "h");
  store.complete(key("k"), { msg: "value correct-horse-battery-staple-9" }, "c");
  assert.equal(store.begin(key("k"), "h").state, "unknown");
});

test("a result over the byte bound is not stored, and the key is never re-run", () => {
  const { store } = make(openDatabase(":memory:"), { maxResultBytes: 100 });
  store.begin(key("k"), "h");
  store.complete(key("k"), { blob: "x".repeat(200) }, "c");
  assert.deepEqual(store.begin(key("k"), "h"), { state: "unknown", reason: "result-not-stored" });
  store.begin(key("ok"), "h");
  store.complete(key("ok"), { blob: "y" }, "c");
  assert.equal(store.begin(key("ok"), "h").state, "replay");
});

test("multi-byte results are bounded by UTF-8 bytes, not characters", () => {
  const { store } = make(openDatabase(":memory:"), { maxResultBytes: 100 });
  store.begin(key("k"), "h");
  store.complete(key("k"), "é".repeat(60), "c"); // 60 chars, 120 bytes
  assert.equal(store.begin(key("k"), "h").state, "unknown");
});

test("the total result bytes are bounded: the oldest completed rows make room", () => {
  let now = 0;
  const { db, store } = make(openDatabase(":memory:"), { now: () => ++now, maxTotalBytes: 60, maxShareBytes: 60 });
  for (const n of ["1", "2", "3", "4"]) {
    store.begin(key(n), "h");
    store.complete(key(n), "z".repeat(20), "c"); // 22 canonical bytes each
  }
  const total = db.prepare("SELECT SUM(result_bytes) AS n FROM daemon_idempotency").get() as { n: number };
  assert.ok(total.n <= 60);
  assert.equal(store.begin(key("4"), "h").state, "replay");
  assert.equal(store.begin(key("3"), "h").state, "replay");
});

test("TTL: a settled key expires and can run again; an in-progress one does not", () => {
  let now = 1_000;
  const { store } = make(openDatabase(":memory:"), { now: () => now, ttlMs: 100, sweepEveryMs: 10_000 });
  store.begin(key("s"), "h");
  store.complete(key("s"), 1, "c");
  store.begin(key("p"), "h");
  now += 99;
  assert.equal(store.begin(key("s"), "h").state, "replay");
  now += 1;
  assert.equal(store.begin(key("s"), "h").state, "new");
  now += 100_000;
  assert.equal(store.begin(key("p"), "h").state, "in-progress");
});

test("expired rows are swept on an interval, not forgotten forever", () => {
  let now = 0;
  const { store } = make(openDatabase(":memory:"), { now: () => now, ttlMs: 10, sweepEveryMs: 50 });
  for (let i = 0; i < 5; i++) {
    store.begin(key(`e${i}`), "h");
    store.complete(key(`e${i}`), i, "c");
  }
  assert.equal(store.size, 5);
  now = 20;
  store.begin(key("later"), "h");
  assert.equal(store.size, 6, "no sweep before the interval");
  now = 60;
  store.begin(key("later2"), "h");
  assert.equal(store.size, 2);
});

test("an actor at its cap evicts only its own oldest settled rows, never another actor's or an in-progress one", () => {
  let now = 0;
  const { store } = make(openDatabase(":memory:"), { now: () => ++now, maxPerActor: 3 });
  store.begin(key("v", { actorId: "victim" }), "h");
  store.complete(key("v", { actorId: "victim" }), "v", "c");
  for (let i = 0; i < 20; i++) {
    store.begin(key(`f${i}`, { actorId: "flood" }), "h");
    store.complete(key(`f${i}`, { actorId: "flood" }), i, "c");
  }
  assert.equal(store.begin(key("v", { actorId: "victim" }), "h").state, "replay");
  assert.equal(store.begin(key("f19", { actorId: "flood" }), "h").state, "replay");
  assert.equal(store.begin(key("f0", { actorId: "flood" }), "h").state, "new", "the oldest was evicted");

  const t = make(openDatabase(":memory:"), { maxPerActor: 2 });
  t.store.begin(key("1"), "h");
  t.store.begin(key("2"), "h");
  assert.deepEqual(t.store.begin(key("3"), "h"), { state: "exhausted" });
  assert.equal(t.store.begin(key("1"), "h").state, "in-progress");
});

test("the global row cap answers exhausted", () => {
  const { store } = make(openDatabase(":memory:"), { maxEntries: 2 });
  store.begin(key("1", { actorId: "a" }), "h");
  store.begin(key("1", { actorId: "b" }), "h");
  assert.deepEqual(store.begin(key("1", { actorId: "c" }), "h"), { state: "exhausted" });
});

test("a key or hash that is malformed is refused", () => {
  const { store } = make();
  assert.throws(() => store.begin(key(""), "h"), { code: "E_INVALID_ARGUMENT" });
  assert.throws(() => store.begin(key("k", { actorId: "x".repeat(600) }), "h"), { code: "E_INVALID_ARGUMENT" });
  assert.throws(() => store.begin(key("k"), "h".repeat(129)), { code: "E_INVALID_ARGUMENT" });
  assert.throws(() => store.begin(key("k", { version: 1.5 }), "h"), { code: "E_INVALID_ARGUMENT" });
});

test("the audit log must share the database handle", () => {
  const db = openDatabase(":memory:");
  assert.throws(() => JournalIdempotencyStore.open(db, { audit: new AuditLog(openDatabase(":memory:")), redactor: new Redactor() }), {
    code: "E_INTERNAL",
  });
});

test("a failed complete leaves the key unknown after abandon, not free to re-run", () => {
  const { db, store } = make();
  store.begin(key("k"), "h");
  db.exec("CREATE TRIGGER boom BEFORE UPDATE ON daemon_idempotency BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  assert.throws(() => store.complete(key("k"), { ok: 1 }, "c"));
  db.exec("DROP TRIGGER boom");
  store.abandon(key("k")); // what the pipeline does after a throwing complete
  assert.deepEqual(store.begin(key("k"), "h"), { state: "unknown", reason: "failed-after-start" });
});

test("a restarted store reads an earlier boot's in-progress row as unknown, even before recover", () => {
  const db = openDatabase(":memory:");
  const first = make(db).store;
  first.begin(key("k"), "h");
  const second = JournalIdempotencyStore.open(db, { audit: new AuditLog(db), redactor: new Redactor() });
  assert.deepEqual(second.begin(key("k"), "h"), { state: "unknown", reason: "interrupted" });
  assert.deepEqual(second.begin(key("k"), "other"), { state: "conflict" });
});

test("recover converts in-progress rows once, audits the count, and converges", () => {
  const dir = mkdtempSync(join(tmpdir(), "axis-idem-"));
  try {
    const db = openDatabase(join(dir, "j.db"));
    const { audit, store } = make(db);
    store.begin(key("1"), "h");
    store.begin(key("2"), "h");
    store.begin(key("3"), "h");
    store.complete(key("3"), 3, "c");
    const next = JournalIdempotencyStore.open(db, { audit, redactor: new Redactor() });
    const lock = acquireInstanceLock(dir);
    assert.deepEqual(next.recover(lock), { interrupted: 2 });
    assert.deepEqual(next.recover(lock), { interrupted: 0 });
    assert.equal(next.begin(key("1"), "h").state, "unknown");
    assert.equal(next.begin(key("3"), "h").state, "replay");
    const events = db.prepare("SELECT target, payload FROM audit_events WHERE action = 'journal.recovery'").all() as Array<{ target: string; payload: string }>;
    assert.equal(events.length, 1);
    assert.equal(events[0]?.target, "idempotency:recovery");
    assert.equal((JSON.parse(events[0]?.payload ?? "{}") as { count?: number }).count, 2);
    assert.equal(audit.verify().ok, true);
    assert.throws(() => next.recover({} as never), { code: "E_INVALID_ARGUMENT" });
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- SIGKILL matrix ----

async function crashChild(dbPath: string, mode: string, delayMs = 0): Promise<void> {
  const child = spawn(process.execPath, [CHILD, dbPath, mode], { stdio: ["ignore", "pipe", "inherit"] });
  const exit = new Promise<string>((resolve) => child.on("exit", (code, signal) => resolve(signal ?? `code:${String(code)}`)));
  await new Promise<void>((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      if (buf.includes("READY")) resolve();
    });
    child.on("error", reject);
    void exit.then((how) => reject(new Error(`child exited before READY: ${how}`)));
  });
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  child.kill("SIGKILL");
  assert.equal(await exit, "SIGKILL");
}

async function afterCrash(mode: string, delayMs = 0) {
  const dir = mkdtempSync(join(tmpdir(), "axis-idem-kill-"));
  await crashChild(join(dir, "j.db"), mode, delayMs);
  const db = openDatabase(join(dir, "j.db"));
  const check = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  assert.equal(check.integrity_check, "ok");
  const { audit, store } = make(db);
  return { dir, db, audit, store, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("SIGKILL between begin and complete: the key is unknown after restart and the handler is not re-run", async () => {
  const c = await afterCrash("begun");
  try {
    const lock = acquireInstanceLock(c.dir);
    assert.deepEqual(c.store.recover(lock), { interrupted: 1 });
    assert.deepEqual(c.store.recover(lock), { interrupted: 0 });
    assert.deepEqual(c.store.begin(key("k1"), "h1"), { state: "unknown", reason: "interrupted" });
    lock.release();
  } finally {
    c.db.close();
    c.done();
  }
});

test("SIGKILL after complete: the restarted store replays the same result", async () => {
  const c = await afterCrash("completed");
  try {
    assert.deepEqual(c.store.begin(key("k1"), "h1"), { state: "replay", result: { ok: true }, origin: "c1" });
    assert.deepEqual(c.store.begin(key("k1"), "different"), { state: "conflict" });
  } finally {
    c.db.close();
    c.done();
  }
});

test("SIGKILL at the COMMIT statement of complete: nothing is half applied, and the outcome is unknown", async () => {
  const c = await afterCrash("at-commit");
  try {
    const row = c.db.prepare("SELECT state, result FROM daemon_idempotency").get() as { state: string; result: string | null };
    assert.equal(row.state, "in-progress", "a completion killed before its COMMIT is rolled back, never half applied");
    assert.equal(row.result, null);
    assert.equal(c.store.begin(key("k1"), "h1").state, "unknown");
  } finally {
    c.db.close();
    c.done();
  }
});

test("SIGKILL at random instants mid-write-loop: the database stays consistent and nothing is left in progress after recover", async () => {
  for (const delay of [0, 3, 11, 29]) {
    const c = await afterCrash("fuzz", delay);
    try {
      const rows = c.db.prepare("SELECT state, result, unknown_reason FROM daemon_idempotency").all() as Array<{
        state: string;
        result: string | null;
        unknown_reason: string | null;
      }>;
      for (const r of rows) {
        assert.equal(r.state === "completed", r.result !== null);
        assert.equal(r.state === "unknown", r.unknown_reason !== null);
      }
      const lock = acquireInstanceLock(c.dir);
      c.store.recover(lock);
      lock.release();
      const left = c.db.prepare("SELECT COUNT(*) AS n FROM daemon_idempotency WHERE state = 'in-progress'").get() as { n: number };
      assert.equal(left.n, 0);
      assert.equal(c.audit.verify().ok, true);
    } finally {
      c.db.close();
      c.done();
    }
  }
});
