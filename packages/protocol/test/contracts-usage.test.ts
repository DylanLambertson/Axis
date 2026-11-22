// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.usage/1 (PV-D3): served, one tier 0 read; a reply is ids and exact integers that add up, and nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contracts, lookupMethod, lookupMethodIn, plannedContracts, usageMethods, usageSummaryRequestSchema, usageSummaryResponseSchema } from "../src/index.js";

test("axis.usage/1 is served, never planned: summary is a tier 0 read with a 5 s timeout", () => {
  assert.equal(contracts["axis.usage/1"]?.["summary"], usageMethods.summary);
  assert.equal(lookupMethod("axis.usage", 1, "summary"), usageMethods.summary);
  assert.equal(lookupMethodIn(plannedContracts, "axis.usage", 1, "summary"), undefined);
  assert.deepEqual(Object.entries(usageMethods).map(([m, s]) => [m, s.sideEffect, s.tier, s.idempotency, s.timeoutMs]), [["summary", "read", 0, "none", 5_000]]);
});

test("the request is a project id and nothing else", () => {
  assert.equal(usageSummaryRequestSchema.safeParse({ projectId: "p1" }).success, true);
  for (const bad of [{}, { projectId: "-p" }, { projectId: "p1", agentId: "a" }, { projectId: "p1", modelId: "m" }]) {
    assert.equal(usageSummaryRequestSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

const t = (runs: number, cost = 0) => ({ runs, inputTokens: runs * 10, outputTokens: runs * 20, tokens: runs * 30, requests: runs, costMicroUsd: cost, unpricedRequests: 0 });
const budget = { tokens: 100, requests: 5, costMicroUsd: null };
const reply = () => ({
  projectId: "p1",
  project: t(5, 900),
  agents: [
    { agentId: "a1", kind: "composer", usage: t(2, 300), budgetRemaining: budget },
    { agentId: "c1", kind: "cli", usage: null, budgetRemaining: null },
  ],
  unattributed: t(3, 600),
});
// The guard refuses an object reached twice, so each check parses a fresh JSON copy (as the wire delivers it).
const ok = (r: unknown): boolean => usageSummaryResponseSchema.safeParse(JSON.parse(JSON.stringify(r))).success;

test("a reply adds up: unattributed plus the listed workers is the project, field by field", () => {
  assert.equal(ok(reply()), true);
  assert.equal(ok({ ...reply(), agents: [], unattributed: t(5, 900) }), true);
  for (const f of ["runs", "inputTokens", "outputTokens", "tokens", "requests", "costMicroUsd", "unpricedRequests"] as const) {
    const r = reply();
    r.unattributed[f] += 1;
    assert.equal(ok(r), false, f);
  }
});

test("a CLI worker's usage and budget are not available; a composer worker's are", () => {
  const r = reply();
  for (const a of [
    { agentId: "c1", kind: "cli", usage: t(0), budgetRemaining: null },
    { agentId: "c1", kind: "cli", usage: null, budgetRemaining: budget },
    { agentId: "c1", kind: "composer", usage: null, budgetRemaining: null },
    { agentId: "c1", kind: "composer", usage: t(0), budgetRemaining: null },
  ]) assert.equal(ok({ ...r, agents: [r.agents[0], a] }), false, JSON.stringify(a));
  assert.equal(ok({ ...r, agents: [r.agents[0], { agentId: "c1", kind: "composer", usage: t(0), budgetRemaining: { tokens: 0, requests: 0, costMicroUsd: 0 } }] }), true);
});

test("integers only, no duplicate worker, no extra field: no name, model, provider, path or text", () => {
  const r = reply();
  for (const bad of [
    { ...r, agents: [r.agents[0], r.agents[0]], unattributed: t(1, 300) },
    { ...r, project: { ...r.project, costMicroUsd: 0.5 } },
    { ...r, project: { ...r.project, costUsd: 1 } },
    { ...r, project: { ...r.project, tokens: Number.MAX_SAFE_INTEGER + 1 } },
    { ...r, unattributed: { ...r.unattributed, requests: -1 } },
    { ...r, agents: [{ ...r.agents[0], name: "Planner" }, r.agents[1]] },
    { ...r, agents: [{ ...r.agents[0], modelId: "m1" }, r.agents[1]] },
    { ...r, agents: [{ ...r.agents[0], budgetRemaining: { ...budget, costMicroUsd: "1" } }, r.agents[1]] },
    { ...r, path: "/repo" },
  ]) assert.equal(ok(bad), false, JSON.stringify(bad).slice(0, 100));
});
