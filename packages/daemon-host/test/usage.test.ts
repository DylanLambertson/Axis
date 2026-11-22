// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-D3: axis.usage/1 from fakes of the journal: project totals, listed workers, unattributed runs, budget left (floored, null
// without a limit), CLI workers not available; the handler serves the user's desktop only, and errors carry no text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditLog, Redactor, openDatabase } from "@axis/audit";
import type { HandlerContext } from "@axis/daemon";
import { Journal } from "@axis/journal";
import { USAGE_REFUSAL_MESSAGE, usageSummaryResponseSchema } from "@axis/protocol";
import { UsageRefusal, createComposerService, createUsageHandlers, createUsageService, remaining, usageServiceDeps, type UsageService, type UsageServiceDeps, type UsageTotalsRow } from "../src/index.js";

const t = (runs: number, cost: number, unpriced = 0): UsageTotalsRow => ({ runs, inputTokens: runs * 10, outputTokens: runs * 20, tokens: runs * 30, requests: runs * 2, costMicroUsd: cost, unpricedRequests: unpriced });
const ZERO = t(0, 0);

function deps(over: Partial<UsageServiceDeps> = {}): UsageServiceDeps {
  return {
    projectExists: (id) => id === "p1",
    agents: () => [
      { id: "a1", kind: "composer", homeWorkspaceId: "w1" },
      { id: "a2", kind: "composer", homeWorkspaceId: "w2" },
      { id: "c1", kind: "cli", homeWorkspaceId: "w3" },
    ],
    usage: () => ({ project: t(10, 1000, 2), byAgent: new Map([["a1", t(3, 300, 1)], ["archived", t(4, 400)], ["c1", t(1, 50)]]) }),
    workspaceSpent: (w) => (w === "w1" ? { tokens: 150, costMicroUsd: 10, requests: 3 } : { tokens: 5000, costMicroUsd: 999, requests: 600 }),
    limits: { maxTokens: 1000, maxRequests: 500 },
    ...over,
  };
}
const summary = (d: UsageServiceDeps) => {
  const s = createUsageService(d).summary("p1");
  assert.equal(usageSummaryResponseSchema.safeParse(JSON.parse(JSON.stringify(s))).success, true, "every answer fits the contract");
  return s;
};

test("project totals, listed workers and runs not attributed to a listed worker add up", () => {
  const s = summary(deps());
  assert.deepEqual(s.project, t(10, 1000, 2));
  assert.deepEqual(s.agents.map((a) => [a.agentId, a.kind, a.usage]), [["a1", "composer", t(3, 300, 1)], ["a2", "composer", ZERO], ["c1", "cli", null]]);
  // An archived worker's runs, runs without a worker, and (if the journal had any) a CLI worker's are all unattributed.
  assert.deepEqual(s.unattributed, { runs: 7, inputTokens: 70, outputTokens: 140, tokens: 210, requests: 14, costMicroUsd: 700, unpricedRequests: 1 });
});

test("budget left: the workspace limit minus what the worker's home workspace spent, floored at zero, null without a limit", () => {
  const s = summary(deps());
  assert.deepEqual(s.agents[0]?.budgetRemaining, { tokens: 850, requests: 497, costMicroUsd: null });
  assert.deepEqual(s.agents[1]?.budgetRemaining, { tokens: 0, requests: 0, costMicroUsd: null }, "overspent is zero, never negative");
  assert.equal(s.agents[2]?.budgetRemaining, null, "a CLI worker has no Axis budget");
  const capped = summary(deps({ limits: { maxCostMicroUsd: 50 } }));
  assert.deepEqual(capped.agents[0]?.budgetRemaining, { tokens: null, requests: null, costMicroUsd: 40 });
  assert.deepEqual([remaining(undefined, 5), remaining(10, 3), remaining(10, 10), remaining(10, 11), remaining(0, 0)], [null, 7, 0, 0, 0]);
});

test("an unregistered project is refused before anything is read", () => {
  const read: string[] = [];
  const d = deps({ usage: () => (read.push("usage"), { project: ZERO, byAgent: new Map() }), agents: () => (read.push("agents"), []) });
  assert.throws(() => createUsageService(d).summary("p2"), UsageRefusal);
  assert.deepEqual(read, []);
});

test("the composed deps (usageServiceDeps, what compose-serving registers): archived workers are not listed, budget left is the real limits minus the real spend", () => {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  journal.registerProject({ id: "p1", path: "/repo/p1", displayName: "p1", trusted: false, actor: "user" });
  const ws = journal.createWorkspace({ projectId: "p1", branch: "axis/w", baseRef: "HEAD", baseSha: "c".repeat(40), createdBy: "user" }).value.id;
  journal.transitionWorkspace(ws, "READY");
  const launch = { kind: "composer", connection: "c", modelId: "m1", mode: "ask" } as const;
  journal.agents.create({ id: "live", projectId: "p1", name: "Live", launch, homeWorkspaceId: ws, groupId: null });
  journal.agents.create({ id: "old", projectId: "p1", name: "Old", launch, homeWorkspaceId: ws, groupId: null });
  const T = "2026-11-22T00:00:00.000Z";
  for (const [id, agent, cost] of [["r1", "live", 100], ["r2", "old", 20], ["r3", null, 3]] as const) {
    db.prepare("INSERT INTO agent_runs (id, workspace_id, kind, state, created_at, updated_at, agent_id) VALUES (?, ?, 'composer', 'COMPLETED', ?, ?, ?)").run(id, ws, T, T, agent);
    db.prepare("INSERT INTO composer_runs (run_id, mode, provider_id, model_id, input_tokens, output_tokens, usage_requests, budget_tokens, budget_cost_micro_usd, budget_requests, created_at) VALUES (?, 'ask', 'mock', 'm1', 1, 1, 1, 2, ?, 1, ?)").run(id, cost, T);
  }
  // The workspace budget as the composer records it, with the run's own totals in the same write.
  journal.composer.recordBudget("r1", ws, { tokens: 2, costMicroUsd: 100, requests: 1, unpricedRequests: 0 }, { tokens: 400, costMicroUsd: 123, requests: 7, unpricedRequests: 0 });
  journal.agents.archive("old");
  const composer = { workspaceLimits: Object.freeze({ maxTokens: 1000, maxRequests: 10, maxCostMicroUsd: 100 }) };
  const d = usageServiceDeps(journal, composer);
  assert.equal(d.limits, composer.workspaceLimits, "the very limits object the composer service enforces");
  const s = summary(d);
  assert.deepEqual(s.agents.map((a) => [a.agentId, a.usage?.costMicroUsd, a.budgetRemaining]), [["live", 100, { tokens: 600, requests: 3, costMicroUsd: 0 }]], "the archived worker is not listed");
  assert.deepEqual([s.project.costMicroUsd, s.project.runs, s.unattributed.costMicroUsd, s.unattributed.runs], [123, 3, 23, 2], "its run counts in project and unattributed");
  assert.equal(d.projectExists("p1") && !d.projectExists("p2"), true);
  db.close();
});

test("the composer service enforces and exposes one frozen limits object, a copy of what it was given (review N-2)", () => {
  const given = { maxTokens: 5, maxRequests: 6 };
  const service = createComposerService({ journal: {} as never, engine: {} as never, now: () => 0, redactor: new Redactor(), workspaceBudget: given });
  try {
    assert.deepEqual(service.workspaceLimits, { maxTokens: 5, maxRequests: 6 });
    assert.equal(Object.isFrozen(service.workspaceLimits), true);
    given.maxTokens = 999;
    assert.equal(service.workspaceLimits.maxTokens, 5, "changing the caller's object later changes neither the enforced nor the reported limits");
    assert.equal(service.workspaceLimits, service.workspaceLimits);
  } finally {
    service.dispose();
  }
});

const ctx = (identity: Record<string, unknown>, aborted = false): HandlerContext => {
  const ac = new AbortController();
  if (aborted) ac.abort();
  return { identity, requestId: "q", correlationId: "c", signal: ac.signal } as unknown as HandlerContext;
};
const USER = { actor: "user", clientKind: "desktop" };
const outcome = async (p: unknown): Promise<string> => {
  try {
    return `ok:${JSON.stringify(await p)}`;
  } catch (e) {
    const x = e as { code?: string; message?: string; details?: unknown };
    return `${x.code}|${x.message}|${JSON.stringify(x.details)}`;
  }
};
const NOT_FOUND = `E_NOT_FOUND|${USAGE_REFUSAL_MESSAGE}|{"reason":"not_found"}`;

test("the handler serves the user's desktop only; an unknown project and a refused caller both get E_NOT_FOUND", async () => {
  const h = createUsageHandlers(createUsageService(deps()));
  assert.ok((await outcome(h.summary(ctx(USER), { projectId: "p1" } as never))).startsWith('ok:{"projectId":"p1","project":'));
  assert.equal(await outcome(h.summary(ctx(USER), { projectId: "p2" } as never)), NOT_FOUND);
  for (const who of [{ actor: "user", clientKind: "web" }, { actor: "agent:a1", clientKind: "desktop" }, { actor: "daemon", clientKind: "desktop" }, {}]) {
    assert.equal(await outcome(h.summary(ctx(who), { projectId: "p1" } as never)), NOT_FOUND, JSON.stringify(who));
  }
  assert.equal(await outcome(h.summary(ctx(USER, true), { projectId: "p1" } as never)), "E_CANCELLED|The request was cancelled.|undefined");
});

test("an out-of-range total, any other error, or an answer outside the contract is E_INTERNAL with no text", async () => {
  const CANARY = "CANARY93cd /home/secret";
  for (const service of [
    { summary: () => { throw new Error(CANARY); } },
    createUsageService(deps({ usage: () => { throw Object.assign(new Error("A usage total is out of range"), { code: "E_INTERNAL" }); } })),
    { summary: () => ({ ...createUsageService(deps()).summary("p1"), note: CANARY }) },
    { summary: () => ({ ...createUsageService(deps()).summary("p1"), unattributed: ZERO }) },
  ] as UsageService[]) {
    assert.equal(await outcome(createUsageHandlers(service).summary(ctx(USER), { projectId: "p1" } as never)), "E_INTERNAL|Request failed|undefined");
  }
});

test("the policy row: served, user only, at the contract's tier, no trust needed, never web-allowed or planned", async () => {
  const { RULES, PLANNED_RULES, WEB_ALLOWED, coverageProblems } = await import("../src/policy/index.js");
  const { usageMethods, plannedContracts } = await import("@axis/protocol");
  assert.equal(plannedContracts["axis.usage/1"], undefined);
  for (const [method, spec] of Object.entries(usageMethods)) {
    const key = `axis.usage/1.${method}`;
    assert.deepEqual([RULES[key]?.actors, RULES[key]?.tier, RULES[key]?.trust], [["user"], spec.tier, "none"], key);
    assert.equal(PLANNED_RULES[key], undefined);
    assert.equal(WEB_ALLOWED.has(key), false);
  }
  assert.deepEqual(coverageProblems(), []);
});
