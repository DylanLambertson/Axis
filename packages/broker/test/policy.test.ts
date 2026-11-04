// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalLedger, BrokerError, TIERS, ToolPolicy, isLauncher, parseTier, verifyApproval } from "../src/index.js";

const input = (o: object = {}) => ({ tool: "t", tier: "read", protectedHit: false, protectedLabels: [], ...o });

test("tiers are exactly five names; NaN, numbers and prototype keys are not tiers", () => {
  assert.deepEqual([...TIERS], ["read", "write", "network", "destructive", "privileged"]);
  for (const bad of [NaN, 0, 3, -1, Infinity, undefined, null, "", "READ", "__proto__", "constructor", "toString", {}, ["read"]]) assert.equal(parseTier(bad), undefined, String(bad));
});

test("default floor: read and write run, network and above need approval", () => {
  const p = new ToolPolicy();
  assert.equal(p.decide(input({ tier: "read" })).effect, "allow");
  assert.equal(p.decide(input({ tier: "write" })).effect, "allow");
  for (const t of ["network", "destructive", "privileged"]) assert.equal(p.decide(input({ tier: t })).effect, "approve", t);
});

test("an invalid tier, raised tier or floor denies; none skips the gate", () => {
  const p = new ToolPolicy();
  for (const bad of [NaN, 7, "bogus", undefined, null]) {
    assert.equal(p.decide(input({ tier: bad })).effect, "deny", String(bad));
    assert.equal(p.decide(input({ raisedTier: bad === undefined ? "bogus" : bad })).effect, "deny", `raised ${String(bad)}`);
  }
  for (const bad of [NaN, 2, "bogus", null, "toString"]) assert.throws(() => new ToolPolicy({ approvalFloor: bad }), BrokerError);
});

test("a raised tier only raises; protected paths force approval whatever the floor", () => {
  const lax = new ToolPolicy({ approvalFloor: "privileged" });
  assert.equal(lax.decide(input({ tier: "destructive" })).effect, "allow");
  assert.equal(lax.decide(input({ tier: "read", raisedTier: "write" })).tier, "write");
  assert.equal(lax.decide(input({ tier: "destructive", raisedTier: "read" })).tier, "destructive");
  const d = lax.decide(input({ tier: "read", protectedHit: true, protectedLabels: [".github/workflows"] }));
  assert.equal(d.effect, "approve");
  assert.ok(d.reasons.includes("protected:.github/workflows"));
});

test("a shell or launcher raises the call to privileged", () => {
  for (const c of ["/bin/sh", "bash", "C:\\Windows\\System32\\cmd.exe", "/usr/bin/env", "xargs", "sudo", "PowerShell.EXE", "/usr/bin/ssh", "python3", "/usr/bin/python3.12", "node", "/usr/bin/node", "perl", "find", "make", "git", "rbash", "npx"]) assert.equal(isLauncher(c), true, c);
  for (const c of ["cargo", "tsc", "eslint", "nodemon-x", "pythonic"]) assert.equal(isLauncher(c), false, c);
  const d = new ToolPolicy().decide(input({ tier: "read", argv0: "/bin/bash" }));
  assert.equal(d.effect === "deny" ? undefined : d.tier, "privileged");
  assert.equal(d.effect, "approve");
});

const digest = "a".repeat(64);
const now = 1_000_000;
const grant = (o: object = {}) => ({ approved: true, approvedBy: "user", approvalId: "appr-0001", digest, expiresAt: now + 60_000, ...o });
const reasonOf = (raw: unknown, ledger = new ApprovalLedger()): string => {
  try {
    verifyApproval(raw, digest, now, 600_000, ledger);
  } catch (e) {
    return (e as BrokerError).reason;
  }
  return "ok";
};

test("approval answers: only a well-formed, user-made, matching, unexpired, single-use grant passes", () => {
  assert.equal(reasonOf(grant()), "ok");
  assert.equal(reasonOf({ approved: false }), "approval-declined");
  assert.equal(reasonOf(grant({ approvedBy: "agent:composer" })), "bad-approver");
  assert.equal(reasonOf(grant({ approvedBy: "daemon" })), "bad-approver");
  assert.equal(reasonOf(grant({ digest: "b".repeat(64) })), "approval-mismatch");
  assert.equal(reasonOf(grant({ expiresAt: now })), "approval-expired");
  assert.equal(reasonOf(grant({ expiresAt: now + 10_000_000 })), "approval-malformed");
  for (const bad of [undefined, null, true, "yes", {}, { approved: "true" }, grant({ expiresAt: NaN }), grant({ extra: 1 }), grant({ approvalId: "x" }), grant({ approved: 1 })]) {
    assert.equal(reasonOf(bad), "approval-malformed", JSON.stringify(bad));
  }
  const ledger = new ApprovalLedger();
  assert.equal(reasonOf(grant(), ledger), "ok");
  assert.equal(reasonOf(grant(), ledger), "approval-replayed");
  const small = new ApprovalLedger(1);
  assert.equal(reasonOf(grant({ approvalId: "appr-aaaa" }), small), "ok");
  assert.throws(() => verifyApproval(grant({ approvalId: "appr-bbbb" }), digest, now, 600_000, small), (e: unknown) => e instanceof BrokerError && e.code === "E_BACKPRESSURE" && e.reason === "approval-limit");
});
