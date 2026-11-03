// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for the re-review of the audit package (NEW-A to NEW-J, S4, S5, S10).
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, Redactor, openDatabase } from "../src/index.js";

// Low-entropy, runtime-assembled stand-ins; none is a credential.
const PW = "Tr0ub4" + "dor-and-3";
const ev = (payload?: unknown, action = "tier4.execute") =>
  ({ actor: "user", action, target: "t", outcome: "success", payload }) as const;

// ---- NEW-B / S4: `name: value` shapes ----

test("NEW-B: colon-separated secret shapes in free text are redacted", () => {
  const r = new Redactor();
  const cases = [
    "pass" + "word: " + PW,
    "client_" + "secret: " + PW,
    "Pass" + "word : " + PW,
    '{"aws_' + "secret_access_" + 'key": "' + PW + '"}',
    '{"db_' + 'password":"' + PW + '","other":1}',
    JSON.stringify(JSON.stringify({ ["api_" + "token"]: PW })),
    "secret_" + "key: " + PW,
    "x-api-" + "key: " + PW,
    "Cookie: sid=" + PW,
    "Authori" + "zation: Bearer " + PW + PW,
    "to" + "ken='" + PW + "'",
    "export DB_" + "PWD=" + PW,
    "failed: pass" + "word: " + PW + " (retry)",
  ];
  for (const c of cases) {
    const out = r.redactString(c);
    assert.ok(!out.includes("Tr0ub4"), `leak: ${c} -> ${out}`);
    assert.equal(r.redactString(out), out, `not idempotent: ${out}`);
  }
});

test("NEW-B: ordinary prose and non-secret names are left alone", () => {
  const r = new Redactor();
  for (const s of ["status: ok", "monkey: banana", "commit message: fix the build", "see https://example.test/a:b"]) {
    assert.equal(r.redactString(s), s);
  }
});

test("NEW-B: an allowlisted free-text field cannot carry a secret into the log", () => {
  const log = new AuditLog(openDatabase(":memory:"));
  const reason = "git push failed: pass" + "word: " + PW;
  const e = log.append(ev({ reason, code: "client_" + "secret: " + PW, errorName: "pass" + "word=" + PW }));
  const stored = JSON.stringify(e.payload);
  assert.ok(!stored.includes("Tr0ub4"), stored);
  const raw = JSON.stringify(log.list()[0]);
  assert.ok(!raw.includes("Tr0ub4"), raw);
});

test("NEW-B: the policy redacts every kept string itself, even if the caller did not", async () => {
  const { applyPayloadPolicy } = await import("../src/payload-policy.js");
  const out = applyPayloadPolicy("tier4.execute", { reason: "pass" + "word: " + PW }, {}, (s) => s.replaceAll("Tr0ub4", "X")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(out), ["[content]"], "an action with no allowlist keeps only a summary");
  const allowed = applyPayloadPolicy("a.b", { reason: "pass" + "word: " + PW }, { "a.b": ["reason"] }, (s) => s.replaceAll("Tr0ub4", "X")) as Record<string, string>;
  assert.ok(!allowed["reason"]?.includes("Tr0ub4"));
});

// ---- NEW-C / S5: sensitive keys count toward the node budget ----

test("NEW-C: a million sensitive keys is bounded, fast and cannot flood the log", () => {
  const r = new Redactor();
  const flood: Record<string, string> = {};
  for (let i = 0; i < 1_000_000; i++) flood[`k${i}tok` + "en"] = "x";
  const t0 = performance.now();
  const out = r.redactValue(flood) as Record<string, unknown>;
  const ms = performance.now() - t0;
  assert.ok(Object.keys(out).length <= 1025, `emitted ${Object.keys(out).length} entries`);
  assert.ok(String(out["[truncated]"]).startsWith("[TRUNCATED:size"));
  assert.ok(ms < 1000, `redactValue took ${ms.toFixed(0)} ms`);

  const log = new AuditLog(openDatabase(":memory:"));
  const t1 = performance.now();
  const e = log.append(ev(flood));
  const appendMs = performance.now() - t1;
  assert.ok(appendMs < 1500, `append took ${appendMs.toFixed(0)} ms`);
  assert.ok(JSON.stringify(e.payload).length < 1024);
});

test("NEW-C: many sensitive keys with long names, and plain keys beyond the per-object cap, are cut", () => {
  const r = new Redactor();
  const o: Record<string, string> = {};
  for (let i = 0; i < 2000; i++) o["x".repeat(16_000) + i + "pass" + "word"] = "v";
  const t0 = performance.now();
  const out = r.redactValue(o) as Record<string, unknown>;
  assert.ok(performance.now() - t0 < 500);
  assert.ok(Object.keys(out).every((k) => k.length <= 300));
  assert.ok(Object.keys(out).length <= 1025);

  const plain: Record<string, number> = {};
  for (let i = 0; i < 5000; i++) plain[`f${i}`] = i;
  assert.equal(Object.keys(r.redactValue(plain) as object).length, 1025);
});

test("NEW-C: a few sensitive keys are still redacted whole", () => {
  const r = new Redactor();
  assert.deepEqual(r.redactValue({ ["pass" + "word"]: PW, ok: 1 }), { ["pass" + "word"]: "[REDACTED:sensitive-field]", ok: 1 });
});

// ---- NEW-A: durability settings ----

test("NEW-A: on macOS the database is opened with fullfsync and checkpoint_fullfsync; synchronous is FULL everywhere", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "axis-fsync-"));
  try {
    const db = openDatabase(join(dir, "f.db"));
    const get = (name: string): unknown => (db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[name];
    assert.equal(get("synchronous"), 2);
    assert.equal(get("journal_mode"), "wal");
    if (process.platform === "darwin") {
      assert.equal(get("fullfsync"), 1);
      assert.equal(get("checkpoint_fullfsync"), 1);
    }
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
