// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AUDIT_SCHEMA_VERSION,
  AuditActions,
  AuditLog,
  AxisError,
  GENESIS_HASH,
  Redactor,
  openDatabase,
  runMigrations,
  schemaVersion,
  type AuditEventInput,
  type DatabaseSync,
} from "../src/index.js";
import { FAKE, FAKE_NEEDLES } from "./fakes.js";

function memLog(redactor?: Redactor): { db: DatabaseSync; log: AuditLog } {
  const db = openDatabase(":memory:");
  const log = new AuditLog(db, { now: () => new Date("2026-11-02T00:00:00.000Z"), ...(redactor ? { redactor } : {}) });
  return { db, log };
}

/** Simulates an attacker with file access: the append-only triggers are dropped first. */
function unlock(db: DatabaseSync): void {
  db.exec("DROP TRIGGER audit_events_no_update; DROP TRIGGER audit_events_no_delete");
}

function seed(log: AuditLog, n = 5): void {
  for (let i = 1; i <= n; i++) {
    log.append({ actor: "user", action: AuditActions.gitCommit, target: `worktree:w${i}`, outcome: "success", payload: { i } });
  }
}

test("events are chained from the genesis hash with contiguous sequence numbers", () => {
  const { log } = memLog();
  seed(log, 3);
  const events = log.list();
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
  assert.equal(events[0]?.prevHash, GENESIS_HASH);
  assert.equal(events[1]?.prevHash, events[0]?.hash);
  assert.equal(events[2]?.prevHash, events[1]?.hash);
  assert.match(events[0]?.hash ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual(log.verify(), { ok: true, count: 3, head: log.head() });
});

test("an empty log verifies", () => {
  assert.deepEqual(memLog().log.verify(), { ok: true, count: 0, head: null });
});

test("the Phase 1a actions are all recorded with actor identity and verify", () => {
  const { log } = memLog();
  const cases: AuditEventInput[] = [
    { actor: "user", action: AuditActions.worktreeRemove, target: "workspace:ws-1", outcome: "success", payload: { removedBranch: false } },
    { actor: "user", action: AuditActions.gitCommit, target: "workspace:ws-1", outcome: "success", payload: { files: 3 } },
    { actor: "user", action: AuditActions.gitPush, target: "workspace:ws-1", outcome: "failure", payload: { remote: "origin" } },
    { actor: "user", action: AuditActions.gitDiscard, target: "workspace:ws-1", outcome: "success", payload: { paths: ["a.ts"] } },
    { actor: "user", action: AuditActions.tier4Challenge, target: "workspace:ws-1", outcome: "success" },
    { actor: "daemon", action: AuditActions.tier4Execute, target: "workspace:ws-1", outcome: "denied", payload: { reason: "challenge_expired" } },
    { actor: "agent:run-42", action: AuditActions.policyDecision, target: "tool:git.push", outcome: "denied" },
  ];
  for (const c of cases) log.append(c);
  const stored = log.list();
  assert.deepEqual(stored.map((e) => e.action), cases.map((c) => c.action));
  assert.deepEqual(stored.map((e) => e.actor), cases.map((c) => c.actor));
  assert.equal(log.verify().ok, true);
});

test("invalid events are rejected with E_INVALID_ARGUMENT and write nothing", () => {
  const { log } = memLog();
  const bad: unknown[] = [
    { actor: "root", action: "git.push", target: "t", outcome: "success" },
    { actor: "agent:", action: "git.push", target: "t", outcome: "success" },
    { actor: "user", action: "Push", target: "t", outcome: "success" },
    { actor: "user", action: "git.push", target: "", outcome: "success" },
    { actor: "user", action: "git.push", target: "t", outcome: "maybe" },
    { actor: "user", action: "git.push", target: "t", outcome: "success", extra: 1 },
  ];
  for (const b of bad) {
    assert.throws(
      () => log.append(b as AuditEventInput),
      (e: unknown) => e instanceof AxisError && e.code === "E_INVALID_ARGUMENT",
    );
  }
  assert.equal(log.head(), null);
});

test("append-only triggers reject UPDATE and DELETE", () => {
  const { db, log } = memLog();
  seed(log, 2);
  assert.throws(() => db.exec("UPDATE audit_events SET outcome = 'denied' WHERE seq = 1"), /append-only/);
  assert.throws(() => db.exec("DELETE FROM audit_events WHERE seq = 1"), /append-only/);
});

test("verify detects an edited field and reports that seq", () => {
  const { db, log } = memLog();
  seed(log, 5);
  unlock(db);
  db.exec("UPDATE audit_events SET outcome = 'denied' WHERE seq = 3");
  assert.deepEqual(log.verify(), { ok: false, firstBadSeq: 3, reason: "hash_mismatch", checked: 2 });
});

test("verify detects an edited payload", () => {
  const { db, log } = memLog();
  seed(log, 4);
  unlock(db);
  db.exec("UPDATE audit_events SET payload = '{\"i\":99}' WHERE seq = 2");
  assert.deepEqual(log.verify(), { ok: false, firstBadSeq: 2, reason: "hash_mismatch", checked: 1 });
});

test("verify detects a deleted row as a sequence gap at the missing seq", () => {
  const { db, log } = memLog();
  seed(log, 5);
  unlock(db);
  db.exec("DELETE FROM audit_events WHERE seq = 3");
  assert.deepEqual(log.verify(), { ok: false, firstBadSeq: 3, reason: "seq_gap", checked: 2 });
});

test("verify detects a deleted first row", () => {
  const { db, log } = memLog();
  seed(log, 3);
  unlock(db);
  db.exec("DELETE FROM audit_events WHERE seq = 1");
  const result = log.verify();
  assert.equal(!result.ok && result.firstBadSeq, 1);
});

test("verify detects reordering: two rows swapped by seq, hashes untouched", () => {
  const { db, log } = memLog();
  seed(log, 5);
  unlock(db);
  db.exec("UPDATE audit_events SET seq = -2 WHERE seq = 2");
  db.exec("UPDATE audit_events SET seq = 2 WHERE seq = 4");
  db.exec("UPDATE audit_events SET seq = 4 WHERE seq = -2");
  const result = log.verify();
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.firstBadSeq, 2);
});

test("verify detects reordering with seq fields rewritten too (hash no longer matches content)", () => {
  const { db, log } = memLog();
  seed(log, 4);
  unlock(db);
  // Move row 3's content to seq 2 and row 2's to seq 3, via the hash-covered seq field.
  db.exec("UPDATE audit_events SET seq = 30 WHERE seq = 3; UPDATE audit_events SET seq = 3 WHERE seq = 2; UPDATE audit_events SET seq = 2 WHERE seq = 30");
  const result = log.verify();
  assert.equal(!result.ok && result.firstBadSeq, 2);
  assert.equal(!result.ok && result.reason, "hash_mismatch");
});

test("a deleted tail is invisible to the chain but caught against a remembered head", () => {
  const { db, log } = memLog();
  seed(log, 5);
  const remembered = log.head();
  assert.ok(remembered);
  unlock(db);
  db.exec("DELETE FROM audit_events WHERE seq > 3");
  assert.equal(log.verify().ok, true);
  assert.deepEqual(log.verify({ expectedHead: remembered }), { ok: false, firstBadSeq: 4, reason: "truncated", checked: 3 });
});

test("a fully recomputed forged suffix is caught by a remembered head", () => {
  const { db, log } = memLog();
  seed(log, 3);
  const remembered = log.head();
  assert.ok(remembered);
  unlock(db);
  db.exec("DELETE FROM audit_events WHERE seq = 3");
  // The forger rebuilds seq 3 with different content and a valid chain.
  const other = new AuditLog(openDatabase(":memory:"), { now: () => new Date("2026-11-02T00:00:00.000Z") });
  seed(other, 2);
  other.append({ actor: "user", action: AuditActions.gitPush, target: "forged", outcome: "success" });
  const forged = other.list()[2];
  assert.ok(forged);
  // Same prev hash only if rows 1-2 are identical, which they are (same clock, same inputs).
  db.prepare("INSERT INTO audit_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)").run(
    forged.seq, forged.ts, forged.actor, forged.action, forged.target, forged.outcome, JSON.stringify(forged.payload), forged.prevHash, forged.hash,
  );
  assert.equal(log.verify().ok, true);
  const result = log.verify({ expectedHead: remembered });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.firstBadSeq, 3);
});

test("a malformed row (wrong column type) is reported, not thrown", () => {
  const { db, log } = memLog();
  seed(log, 3);
  unlock(db);
  db.exec("UPDATE audit_events SET payload = 'not json' WHERE seq = 2");
  assert.deepEqual(log.verify(), { ok: false, firstBadSeq: 2, reason: "malformed_row", checked: 1 });
});

test("payload and target are redacted before hashing and storage", () => {
  const redactor = new Redactor();
  redactor.registerSecret(FAKE.vaultKey);
  const { db, log } = memLog(redactor);
  const event = log.append({
    actor: "user",
    action: AuditActions.gitPush,
    target: `https://bob:${FAKE.password}@example.test/r.git`,
    outcome: "failure",
    // `branch` is allowlisted for git.push, so its value is stored (redacted); the other keys are dropped outright.
    payload: { branch: `${FAKE.github} ${FAKE.vaultKey} Authorization: Bearer ${FAKE.jwt}`, stderr: `fatal: ${FAKE.anthropic}`, token: FAKE.anthropic },
  });
  const dump = JSON.stringify(event) + JSON.stringify(db.prepare("SELECT * FROM audit_events").all());
  for (const needle of FAKE_NEEDLES) assert.ok(!dump.includes(needle), "audit row leaked a fake credential");
  assert.equal(event.target, "https://[REDACTED:url-credentials]@example.test/r.git");
  assert.equal(log.verify().ok, true);
});

test("the database files on disk contain no planted canary", () => {
  const dir = mkdtempSync(join(tmpdir(), "axis-audit-"));
  try {
    const path = join(dir, "journal.db");
    const redactor = new Redactor();
    redactor.registerSecret(FAKE.vaultKey);
    const db = openDatabase(path);
    const log = new AuditLog(db, { redactor });
    log.append({
      actor: "daemon",
      action: AuditActions.tier4Execute,
      target: "x:1",
      outcome: "error",
      payload: { reason: `${FAKE.anthropic} ${FAKE.vaultKey} ${FAKE.privateKey}`, message: `${FAKE.anthropic}`, nested: [FAKE.jwt, FAKE.openai] },
    });
    db.close();
    for (const name of readdirSync(dir)) {
      const bytes = readFileSync(join(dir, name)).toString("latin1");
      for (const needle of FAKE_NEEDLES) assert.ok(!bytes.includes(needle), `${name} contains a fake credential`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("append inside a caller's transaction rolls back with it", () => {
  const { db, log } = memLog();
  seed(log, 1);
  db.exec("BEGIN IMMEDIATE");
  log.append({ actor: "user", action: AuditActions.gitCommit, target: "t", outcome: "success" });
  assert.equal(log.head()?.seq, 2);
  db.exec("ROLLBACK");
  assert.equal(log.head()?.seq, 1);
  assert.equal(log.verify().ok, true);
});

test("migrations record a schema version, are idempotent, and refuse a newer database", () => {
  const db = openDatabase(":memory:");
  new AuditLog(db);
  assert.equal(schemaVersion(db, "audit"), AUDIT_SCHEMA_VERSION);
  new AuditLog(db); // reopening applies nothing and does not fail
  assert.equal(schemaVersion(db, "audit"), AUDIT_SCHEMA_VERSION);
  db.prepare("UPDATE axis_schema SET version = 99 WHERE component = 'audit'").run();
  assert.throws(
    () => new AuditLog(db),
    (e: unknown) => e instanceof AxisError && e.code === "E_UNAVAILABLE",
  );
});

test("a failing migration rolls back entirely and leaves the version unchanged", () => {
  const db = openDatabase(":memory:");
  runMigrations(db, "demo", [{ version: 1, sql: "CREATE TABLE demo_a (x INTEGER)" }]);
  assert.throws(() =>
    runMigrations(db, "demo", [
      { version: 1, sql: "CREATE TABLE demo_a (x INTEGER)" },
      { version: 2, sql: "CREATE TABLE demo_b (x INTEGER); INSERT INTO missing_table VALUES (1)" },
    ]),
  );
  assert.equal(schemaVersion(db, "demo"), 1);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'demo_b'").get(), undefined);
});

test("checkpoint returns an anchor that catches later tail deletion; it refuses to anchor a broken chain", () => {
  const { db, log } = memLog();
  assert.equal(log.checkpoint(), null);
  seed(log, 4);
  const anchor = log.checkpoint();
  assert.deepEqual(anchor, { seq: 4, hash: log.head()?.hash });
  assert.ok(anchor);
  seed(log, 2);
  assert.equal(log.verify({ expectedHead: anchor }).ok, true, "a longer chain that contains the anchor is fine");
  unlock(db);
  db.exec("DELETE FROM audit_events WHERE seq > 3");
  assert.equal(log.verify({ expectedHead: anchor }).ok, false);
  db.exec("UPDATE audit_events SET outcome = 'denied' WHERE seq = 2");
  assert.throws(
    () => log.checkpoint(),
    (e: unknown) => e instanceof AxisError && e.code === "E_INTERNAL" && e.detail["firstBadSeq"] === 2,
  );
});

test("isBoundTo is identity on the connection", () => {
  const { db, log } = memLog();
  assert.equal(log.isBoundTo(db), true);
  assert.equal(log.isBoundTo(openDatabase(":memory:")), false);
});
