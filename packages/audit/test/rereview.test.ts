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
