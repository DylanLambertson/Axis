// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase, type DatabaseSync } from "@axis/audit";
import { Journal } from "../src/index.js";

// Usage and cost of a project's composer runs (ticket PV-D3, `axis.usage/1`): exact integer totals per project and per agent,
// from the J2 records. Every case has a refusing neighbour: another project, a CLI run, a run without an agent; and a total
// that a JS number cannot hold exactly is refused, never rounded.

const T = "2026-11-22T00:00:00.000Z";

function setup() {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  for (const id of ["p1", "p2"]) journal.registerProject({ id, path: `/repo/${id}`, displayName: id, trusted: false, actor: "user" });
  let n = 0;
  const ws = (projectId: string): string => {
    const id = journal.createWorkspace({ projectId, branch: `axis/w${n++}`, baseRef: "HEAD", baseSha: "c".repeat(40), createdBy: "user" }).value.id;
    journal.transitionWorkspace(id, "READY");
    return id;
  };
  return { db, journal, ws };
}

interface Spend {
  readonly agentId?: string;
  readonly kind?: "composer" | "cli";
  readonly usage?: readonly [number, number, number] | null; // input, output, requests (null: no reply yet)
  readonly budget?: readonly [number, number, number, number]; // tokens, cost, requests, unpriced
}
let seq = 0;
/** A run as the journal holds it once it ended: written directly, so any total (and an agent's run) can be crafted. */
function run(db: DatabaseSync, workspaceId: string, s: Spend = {}): string {
  const id = `run-${seq++}`;
  db.prepare("INSERT INTO agent_runs (id, workspace_id, kind, state, created_at, updated_at, agent_id) VALUES (?, ?, ?, 'COMPLETED', ?, ?, ?)")
    .run(id, workspaceId, s.kind ?? "composer", T, T, s.agentId ?? null);
  if ((s.kind ?? "composer") === "composer") {
    const u = s.usage === undefined ? [10, 20, 1] : s.usage;
    const b = s.budget ?? [30, 400, 1, 0];
    db.prepare(`INSERT INTO composer_runs (run_id, mode, provider_id, model_id, input_tokens, output_tokens, usage_requests,
      budget_tokens, budget_cost_micro_usd, budget_requests, budget_unpriced, created_at) VALUES (?, 'ask', 'mock', 'm1', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, u?.[0] ?? null, u?.[1] ?? null, u?.[2] ?? null, b[0], b[1], b[2], b[3], T);
  }
  return id;
}
const totals = (runs: number, inputTokens: number, outputTokens: number, tokens: number, requests: number, costMicroUsd: number, unpricedRequests: number) =>
  ({ runs, inputTokens, outputTokens, tokens, requests, costMicroUsd, unpricedRequests });

test("a project with no composer run has zero totals and no agent", () => {
  const { journal } = setup();
  assert.deepEqual(journal.composer.projectUsage("p1"), { project: totals(0, 0, 0, 0, 0, 0, 0), byAgent: new Map() });
  assert.deepEqual(journal.composer.projectUsage("nope").project, totals(0, 0, 0, 0, 0, 0, 0));
});

test("project totals: every composer run of every workspace of the project, a removed one's included; CLI runs and other projects are not", () => {
  const { db, journal, ws } = setup();
  const [a, b, gone, other] = [ws("p1"), ws("p1"), ws("p1"), ws("p2")];
  run(db, a, { usage: [1, 2, 1], budget: [5, 100, 1, 0] });
  run(db, b, { usage: [10, 20, 2], budget: [40, 2000, 2, 1] });
  run(db, b, { usage: null, budget: [7, 0, 1, 1] }); // no reply yet: its budget still counts (what it reserved)
  run(db, gone, { usage: [100, 200, 3], budget: [300, 30000, 3, 0] });
  run(db, a, { kind: "cli" });
  run(db, other, { usage: [1000, 1000, 9], budget: [9000, 9000, 9, 9] });
  journal.transitionWorkspace(gone, "REMOVING", { actor: "user", reason: "USER_REMOVED" });
  journal.transitionWorkspace(gone, "REMOVED");
  assert.deepEqual(journal.composer.projectUsage("p1").project, totals(4, 111, 222, 352, 7, 32100, 2));
  assert.deepEqual(journal.composer.projectUsage("p2").project, totals(1, 1000, 1000, 9000, 9, 9000, 9));
});

test("per agent: runs started for an agent, grouped by agent id; runs without one are in the project total only", () => {
  const { db, journal, ws } = setup();
  const [home1, home2, other] = [ws("p1"), ws("p1"), ws("p2")];
  journal.agents.create({ id: "ag1", projectId: "p1", name: "One", launch: { kind: "composer", connection: "c", modelId: "m1", mode: "ask" }, homeWorkspaceId: home1, groupId: null });
  journal.agents.create({ id: "ag2", projectId: "p1", name: "Two", launch: { kind: "composer", connection: "c", modelId: "m1", mode: "ask" }, homeWorkspaceId: home2, groupId: null });
  journal.agents.create({ id: "ag3", projectId: "p2", name: "Three", launch: { kind: "composer", connection: "c", modelId: "m1", mode: "ask" }, homeWorkspaceId: other, groupId: null });
  run(db, home1, { agentId: "ag1", usage: [1, 1, 1], budget: [2, 10, 1, 0] });
  run(db, home1, { agentId: "ag1", usage: [2, 2, 1], budget: [4, 20, 1, 1] });
  run(db, home2, { agentId: "ag2", usage: [5, 5, 1], budget: [10, 50, 1, 0] });
  run(db, home1, { usage: [7, 7, 1], budget: [14, 70, 1, 0] });
  run(db, other, { agentId: "ag3" });
  journal.agents.archive("ag2"); // archived: its runs keep their agent id (the daemon decides what is listed)
  const u = journal.composer.projectUsage("p1");
  assert.deepEqual([...u.byAgent.entries()].sort(), [["ag1", totals(2, 3, 3, 6, 2, 30, 1)], ["ag2", totals(1, 5, 5, 10, 1, 50, 0)]]);
  assert.deepEqual(u.project, totals(4, 15, 15, 30, 4, 150, 1));
});

test("a total above Number.MAX_SAFE_INTEGER is refused, never rounded; one at it is exact", () => {
  const { db, journal, ws } = setup();
  const a = ws("p1");
  const max = Number.MAX_SAFE_INTEGER;
  run(db, a, { budget: [0, max - 1, 0, 0] });
  run(db, a, { budget: [0, 1, 0, 0] });
  assert.equal(journal.composer.projectUsage("p1").project.costMicroUsd, max, "exactly 2^53 - 1 is exact");
  run(db, a, { budget: [0, 1, 0, 0] });
  assert.throws(() => journal.composer.projectUsage("p1"), /out of range/, "2^53 would be read as a rounded number");
  // A total a JS number would round to a wrong value is refused the same way.
  const b = ws("p2");
  run(db, b, { budget: [0, 0, 0, 0], usage: [2 ** 60 + 1, 0, 0] });
  assert.throws(() => journal.composer.projectUsage("p2"), /out of range/);
});

test("a sum past 64 bits is an error from SQLite, not a wrapped or float total", () => {
  const { db, journal, ws } = setup();
  const a = ws("p1");
  db.prepare("INSERT INTO agent_runs (id, workspace_id, kind, state, created_at, updated_at) VALUES ('big1', ?, 'composer', 'COMPLETED', ?, ?), ('big2', ?, 'composer', 'COMPLETED', ?, ?)").run(a, T, T, a, T, T);
  for (const id of ["big1", "big2"]) {
    db.prepare("INSERT INTO composer_runs (run_id, mode, provider_id, model_id, budget_tokens, created_at) VALUES (?, 'ask', 'mock', 'm1', 9223372036854775807, ?)").run(id, T);
  }
  assert.throws(() => journal.composer.projectUsage("p1"), /integer overflow/);
});

test("a workspace's budget totals are read exactly: 2^53 - 1 is exact, above it is refused, never rounded (review N-3)", () => {
  const { db, journal, ws } = setup();
  const a = ws("p1");
  assert.deepEqual(journal.composer.workspaceBudget(a), { tokens: 0, costMicroUsd: 0, requests: 0, unpricedRequests: 0 });
  const max = Number.MAX_SAFE_INTEGER;
  db.prepare("INSERT INTO composer_workspace_budgets (workspace_id, tokens, cost_micro_usd, requests, unpriced, updated_at) VALUES (?, 1, ?, 2, 3, ?)").run(a, max, T);
  assert.deepEqual(journal.composer.workspaceBudget(a), { tokens: 1, costMicroUsd: max, requests: 2, unpricedRequests: 3 });
  db.prepare("UPDATE composer_workspace_budgets SET tokens = 9007199254740992 WHERE workspace_id = ?").run(a);
  assert.throws(() => journal.composer.workspaceBudget(a), /out of range/);
});
