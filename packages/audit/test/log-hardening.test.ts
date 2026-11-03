// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for the security review of the audit log (B3, S1, S2, S12, N3, N4, N5).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AuditLog,
  AxisError,
  DEFAULT_PAYLOAD_ALLOWLIST,
  HASH_VERSION,
  MAX_PAYLOAD_CHARS,
  assertPrivateFiles,
  canonicalize,
  openDatabase,
  withTransaction,
  type AuditEventInput,
  type DatabaseSync,
} from "../src/index.js";

const code = (c: string) => (e: unknown) => e instanceof AxisError && e.code === c;
const T = "2026-11-02T00:00:00.000Z";

function mem(): { db: DatabaseSync; log: AuditLog } {
  const db = openDatabase(":memory:");
  return { db, log: new AuditLog(db, { now: () => new Date(T) }) };
}
const ev = (over: Partial<AuditEventInput> = {}): AuditEventInput => ({
  actor: "user",
  action: "git.commit",
  target: "workspace:ws-1",
  outcome: "success",
  ...over,
});
const unlock = (db: DatabaseSync): void => db.exec("DROP TRIGGER audit_events_no_update; DROP TRIGGER audit_events_no_delete");

// ---- B3 ----

test("B3: a lone surrogate in target, actor or action is rejected and the chain stays verifiable", () => {
  const { log } = mem();
  log.append(ev({ target: "worktree:ok" }));
  for (const bad of [ev({ target: "worktree:\uD800" }), ev({ target: "\uDC00x" }), ev({ actor: "agent:x\uD800" }), ev({ action: "git.\uD800" })]) {
    assert.throws(() => log.append(bad), code("E_INVALID_ARGUMENT"));
  }
  log.append(ev({ target: "worktree:ok2" }));
  assert.equal(log.verify().ok, true);
  assert.doesNotThrow(() => log.checkpoint());
  assert.equal(log.head()?.seq, 2);
});

test("B3: lone surrogates in a payload are made well-formed, so stored and hashed forms agree", () => {
  const { log } = mem();
  log.append(ev({ action: "git.push", payload: { branch: "feat/\uD800x", remote: "o\uDC00" } }));
  log.append(ev({ target: "\u{1F600} and é and   and \u0000" }));
  assert.equal(log.verify().ok, true);
});

// ---- S1 ----

test("S1: payloads are stored only through the per-action allowlist; the rest is counted, not kept", () => {
  const { log } = mem();
  const e = log.append(ev({ action: "git.commit", payload: { workspaceId: "ws-1", fileCount: 3, stdout: "SECRET-OUTPUT-TEXT", diff: "x".repeat(5000) } }));
  assert.deepEqual(e.payload, { _omitted: 2, fileCount: 3, workspaceId: "ws-1" });
  assert.ok(!JSON.stringify(e).includes("SECRET-OUTPUT-TEXT"));
});

test("S1: an action with no allowlist stores only a length and hash of its payload", () => {
  const { log } = mem();
  const e = log.append(ev({ action: "agent.toolcall", payload: { cmd: "ls", out: "VISIBLE-TEXT" } }));
  const p = e.payload as { "[content]": { length: number; sha256: string } };
  assert.deepEqual(Object.keys(e.payload as object), ["[content]"]);
  assert.match(p["[content]"].sha256, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(e).includes("VISIBLE-TEXT"));
});

test("S1: non-scalar values under an allowed key, binary data and over-long strings are summarised or cut", () => {
  const { log } = mem();
  const e = log.append(
    ev({
      action: "git.push",
      payload: { remote: { nested: "OBJECT-TEXT" }, branch: "b".repeat(1000), ok: true, stderr: Buffer.from("RAW-STDERR") },
    }),
  );
  const p = e.payload as Record<string, unknown>;
  assert.ok("[content]" in (p["remote"] as object));
  assert.match(String(p["branch"]), /\[TRUNCATED:1000\]$/);
  assert.equal(p["ok"], true);
  const json = JSON.stringify(e);
  for (const leak of ["OBJECT-TEXT", "RAW-STDERR", "82,65,87"]) assert.ok(!json.includes(leak), leak);
});

test("S1: a non-object payload is reduced to a summary, null stays null, and a custom allowlist can widen an action", () => {
  const { log } = mem();
  assert.deepEqual(Object.keys(log.append(ev({ payload: "just a string" })).payload as object), ["[content]"]);
  assert.equal(log.append(ev({ payload: undefined })).payload, null);
  const db = openDatabase(":memory:");
  const wide = new AuditLog(db, { payloadAllowlist: { "agent.approval": ["approver", "expiresAt"] } });
  const e = wide.append(ev({ action: "agent.approval", payload: { approver: "user", expiresAt: 1, other: 1 } }));
  assert.deepEqual(e.payload, { _omitted: 1, approver: "user", expiresAt: 1 });
  assert.ok(Object.hasOwn(DEFAULT_PAYLOAD_ALLOWLIST, "journal.recovery"));
});

test("S1: the stored payload never exceeds the hard byte cap", () => {
  const keys = Array.from({ length: 200 }, (_, i) => `k${i}`);
  const db = openDatabase(":memory:");
  const log = new AuditLog(db, { payloadAllowlist: { "big.event": keys } });
  const payload = Object.fromEntries(keys.map((k) => [k, "v".repeat(200)]));
  const e = log.append(ev({ action: "big.event", payload }));
  assert.ok(canonicalize(e.payload).length <= MAX_PAYLOAD_CHARS);
  assert.deepEqual(Object.keys(e.payload as object), ["[content]"]);
});

// ---- N3 ----

test("N3: the hashed form carries a version tag and each row stores its hash version", () => {
  const { db, log } = mem();
  const e = log.append(ev({ payload: { workspaceId: "w" } }));
  assert.equal(HASH_VERSION, 1);
  const row = db.prepare("SELECT hash_version FROM audit_events").get() as { hash_version: number };
  assert.equal(row.hash_version, 1);
  const untagged = createHash("sha256")
    .update(canonicalize({ seq: e.seq, ts: e.ts, actor: e.actor, action: e.action, target: e.target, outcome: e.outcome, payload: e.payload, prevHash: e.prevHash }))
    .digest("hex");
  assert.notEqual(untagged, e.hash, "the version is part of the hash input");
  unlock(db);
  db.exec("UPDATE audit_events SET hash_version = 2");
  assert.deepEqual(log.verify(), { ok: false, firstBadSeq: 1, reason: "unsupported_version", checked: 0 });
});

// ---- S12 ----

test("S12: checkpoint(since) verifies only what was appended after the previous anchor", () => {
  const { db, log } = mem();
  for (let i = 0; i < 300; i++) log.append(ev());
  const a1 = log.checkpoint();
  assert.equal(a1?.seq, 300);
  for (let i = 0; i < 5; i++) log.append(ev());
  assert.ok(a1);
  const incremental = log.verify({ from: a1 });
  assert.equal(incremental.ok && incremental.count, 305);
  assert.equal(!incremental.ok ? 0 : incremental.head?.seq, 305);
  assert.equal(log.checkpoint(a1)?.seq, 305);
  // The incremental check inspected exactly the 5 new rows: it still succeeds when old rows are rotten (the full check at startup catches those).
  unlock(db);
  db.exec("UPDATE audit_events SET outcome = 'denied' WHERE seq = 10");
  assert.equal(log.verify({ from: a1 }).ok, true);
  assert.equal(log.verify().ok, false);
  assert.throws(() => log.checkpoint(), code("E_INTERNAL"));
});

test("S12: an incremental check catches tampering inside the new range, a changed anchor row and a truncated log", () => {
  const { db, log } = mem();
  for (let i = 0; i < 10; i++) log.append(ev());
  const a = log.checkpoint();
  assert.ok(a);
  for (let i = 0; i < 4; i++) log.append(ev());
  unlock(db);
  db.exec("UPDATE audit_events SET target = 'workspace:evil' WHERE seq = 12");
  assert.deepEqual(log.verify({ from: a }), { ok: false, firstBadSeq: 12, reason: "hash_mismatch", checked: 1 });
  assert.equal(log.verify({ from: { seq: a.seq, hash: "0".repeat(64) } }).ok, false);
  db.exec("DELETE FROM audit_events WHERE seq > 5");
  const r = log.verify({ from: a });
  assert.equal(!r.ok && r.reason, "truncated");
});

// ---- S2 ----

const modeOf = (p: string): number => statSync(p).mode & 0o777;

test("S2: the database, -wal and -shm files are 0600 and the directory 0700, whatever the umask", { skip: process.platform === "win32" }, () => {
  const old = process.umask(0o022);
  const root = mkdtempSync(join(tmpdir(), "axis-perm-"));
  try {
    const path = join(root, "state", "axis.db");
    const db = openDatabase(path);
    const log = new AuditLog(db);
    for (let i = 0; i < 5; i++) log.append(ev());
    assertPrivateFiles(path);
    assert.equal(modeOf(path), 0o600);
    assert.equal(modeOf(`${path}-wal`), 0o600);
    assert.equal(modeOf(`${path}-shm`), 0o600);
    assert.equal(modeOf(join(root, "state")), 0o700);
    db.close();
  } finally {
    process.umask(old);
    rmSync(root, { recursive: true, force: true });
  }
});

test("S2/NEW-J: a pre-existing loose file is tightened on open; a pre-existing directory is the caller's and is left alone", { skip: process.platform === "win32" }, () => {
  const old = process.umask(0o022);
  const root = mkdtempSync(join(tmpdir(), "axis-perm-"));
  try {
    const dir = join(root, "loose");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    const path = join(dir, "axis.db");
    writeFileSync(path, "", { mode: 0o644 });
    chmodSync(path, 0o644);
    openDatabase(path).close();
    assert.equal(modeOf(dir), 0o755, "an existing directory is not ours to chmod");
    assert.equal(modeOf(path), 0o600);
    // A directory the call creates is private.
    const fresh = join(root, "new", "deeper");
    openDatabase(join(fresh, "axis.db")).close();
    assert.equal(modeOf(fresh), 0o700);
  } finally {
    process.umask(old);
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- N4, N5 ----

test("N4: busyTimeoutMs is validated", () => {
  for (const bad of [Number.NaN, -1, 1.5, 10_000_000]) {
    assert.throws(() => openDatabase(":memory:", { busyTimeoutMs: bad }), code("E_INVALID_ARGUMENT"));
  }
});

test("N5: a locked database surfaces as retryable E_UNAVAILABLE and constraint errors as E_INTERNAL without SQL text", () => {
  const root = mkdtempSync(join(tmpdir(), "axis-busy-"));
  try {
    const path = join(root, "axis.db");
    const holder = openDatabase(path);
    new AuditLog(holder);
    const waiter = openDatabase(path, { busyTimeoutMs: 30 });
    const log = new AuditLog(waiter);
    holder.exec("BEGIN IMMEDIATE");
    assert.throws(() => log.append(ev()), (e: unknown) => e instanceof AxisError && e.code === "E_UNAVAILABLE" && e.toWire("c").retryable);
    holder.exec("ROLLBACK");

    holder.exec("CREATE TABLE u (x INTEGER PRIMARY KEY)");
    holder.exec("INSERT INTO u VALUES (1)");
    assert.throws(
      () => withTransaction(holder, () => holder.exec("INSERT INTO u VALUES (1)")),
      (e: unknown) => e instanceof AxisError && e.code === "E_INTERNAL" && !/INSERT|UNIQUE|u\.x/i.test(e.message),
    );
    holder.close();
    waiter.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
