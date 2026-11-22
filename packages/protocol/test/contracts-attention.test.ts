// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.attention/1 (PV-D4): served, one tier 0 read; a reply is ids and saturating counts and nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATTENTION_COUNT_CAP,
  ATTENTION_MAX_AGENTS,
  attentionMethods,
  attentionSummaryRequestSchema,
  attentionSummaryResponseSchema,
  contracts,
  lookupMethod,
  lookupMethodIn,
  plannedContracts,
} from "../src/index.js";

test("axis.attention/1 is served, never planned: summary is a tier 0 read with a 5 s timeout", () => {
  assert.equal(contracts["axis.attention/1"]?.["summary"], attentionMethods.summary);
  assert.equal(lookupMethod("axis.attention", 1, "summary"), attentionMethods.summary);
  assert.equal(lookupMethodIn(plannedContracts, "axis.attention", 1, "summary"), undefined);
  assert.deepEqual(Object.entries(attentionMethods).map(([m, s]) => [m, s.sideEffect, s.tier, s.idempotency, s.timeoutMs]), [["summary", "read", 0, "none", 5_000]]);
  assert.equal([ATTENTION_COUNT_CAP, ATTENTION_MAX_AGENTS].join(), "999,64");
});

test("the request is a project id and nothing else", () => {
  assert.equal(attentionSummaryRequestSchema.safeParse({ projectId: "p1" }).success, true);
  for (const bad of [{}, { projectId: "" }, { projectId: "-p" }, { projectId: "a/b" }, { projectId: "p1", agentId: "a" }, { projectId: "p1", path: "/x" }]) {
    assert.equal(attentionSummaryRequestSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

const ZERO = { n: 0, capped: false };
const CAP = { n: ATTENTION_COUNT_CAP, capped: true };
const base = { projectId: "p1", approvalsWaiting: { total: ZERO, byAgent: [], more: false }, failedRuns: ZERO, quietCliRuns: ZERO, driftFlags: ZERO, unreadMessages: ZERO };
// The guard refuses an object reached twice, so each check parses a fresh JSON copy (as the wire delivers it).
const ok = (r: unknown): boolean => attentionSummaryResponseSchema.safeParse(JSON.parse(JSON.stringify(r))).success;
const agents = (n: number) => Array.from({ length: n }, (_, i) => ({ agentId: `a${i}`, n: 1 }));

test("a count saturates at 999 and is capped only there", () => {
  assert.equal(ok(base), true);
  for (const c of [{ n: 1, capped: false }, { n: ATTENTION_COUNT_CAP, capped: false }, CAP]) assert.equal(ok({ ...base, driftFlags: c }), true, JSON.stringify(c));
  for (const c of [{ n: 1000, capped: false }, { n: 1000, capped: true }, { n: 998, capped: true }, { n: -1, capped: false }, { n: 1.5, capped: false }, { n: 1 }, { n: 1, capped: false, text: "x" }, 3]) {
    assert.equal(ok({ ...base, unreadMessages: c }), false, JSON.stringify(c));
  }
});

test("approvals per agent: listed when waiting, adding up to the total, at most 64 then more, no duplicate", () => {
  const two = { total: { n: 3, capped: false }, byAgent: [{ agentId: null, n: 1 }, { agentId: "a1", n: 2 }], more: false };
  assert.equal(ok({ ...base, approvalsWaiting: two }), true);
  assert.equal(ok({ ...base, approvalsWaiting: { ...two, total: { n: 4, capped: false } } }), false, "the agents add up to the total");
  assert.equal(ok({ ...base, approvalsWaiting: { total: { n: 1, capped: false }, byAgent: [], more: false } }), false, "a waiting run is listed (the agents add up)");
  assert.equal(ok({ ...base, approvalsWaiting: { total: ZERO, byAgent: [{ agentId: "a1", n: 1 }], more: false } }), false, "nothing listed at zero (the agents add up)");
  assert.equal(ok({ ...base, approvalsWaiting: { total: CAP, byAgent: [], more: false } }), true, "a full scan window may list none");
  assert.equal(ok({ ...base, approvalsWaiting: { total: CAP, byAgent: [{ agentId: "a1", n: 1 }], more: false } }), true, "capped need not add up");
  assert.equal(ok({ ...base, approvalsWaiting: { total: { n: 2, capped: false }, byAgent: [{ agentId: "a1", n: 1 }, { agentId: "a1", n: 1 }], more: false } }), false, "duplicate agent");
  assert.equal(ok({ ...base, approvalsWaiting: { total: { n: 64, capped: false }, byAgent: agents(64), more: false } }), true);
  assert.equal(ok({ ...base, approvalsWaiting: { total: { n: 70, capped: false }, byAgent: agents(64), more: true } }), true, "more past a full list need not add up");
  assert.equal(ok({ ...base, approvalsWaiting: { total: { n: 64, capped: false }, byAgent: agents(64), more: true } }), false, "more means some agent is not listed");
  assert.equal(ok({ ...base, approvalsWaiting: { total: { n: 65, capped: false }, byAgent: agents(65), more: false } }), false, "at most 64");
  assert.equal(ok({ ...base, approvalsWaiting: { total: { n: 70, capped: false }, byAgent: agents(63), more: true } }), false, "more only past a full list");
  for (const e of [{ agentId: "a/b", n: 1 }, { agentId: "a1", n: 0 }, { agentId: "a1", n: 1000 }, { agentId: "a1", n: 1, name: "Planner" }]) {
    assert.equal(ok({ ...base, approvalsWaiting: { total: { n: e.n, capped: false }, byAgent: [e], more: false } }), false, JSON.stringify(e));
  }
});

test("a reply carries no field but the ids and counts: no text, path, reason or challenge", () => {
  for (const extra of [{ summary: "x" }, { path: "/repo" }, { reasons: ["FAILED"] }, { challenges: [] }]) assert.equal(ok({ ...base, ...extra }), false, JSON.stringify(extra));
  const { failedRuns: _omitted, ...missing } = base;
  assert.equal(ok(missing), false);
  assert.equal(ok({ ...base, approvalsWaiting: { ...base.approvalsWaiting, challengeIds: [] } }), false);
});
