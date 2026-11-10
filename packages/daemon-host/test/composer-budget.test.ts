// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BudgetTotals } from "@axis/journal";
import { createRunBudget, type BudgetRequestInfo, type BudgetUsageInfo, type RunBudget } from "@axis/providers";
import { BUDGET_REASONS, createComposerBudget, durableTotals } from "../src/index.js";

let n = 0;
const ask = (over: Partial<BudgetRequestInfo> = {}): BudgetRequestInfo => ({
  requestId: `req-${++n}`, runId: "run-1", providerId: "mock", connectionId: "conn", model: "m",
  maxOutputTokens: 100, estimatedInputTokens: 10, costKnown: true, worstCaseCost: undefined, ...over,
});
const settle = (info: BudgetRequestInfo, input: number, output: number): BudgetUsageInfo => ({
  requestId: info.requestId, runId: info.runId, providerId: info.providerId, connectionId: info.connectionId, model: info.model,
  usage: { inputTokens: input, outputTokens: output }, charged: "reported", cost: undefined, outcome: "completed",
});

function rig(run: RunBudget, workspace: RunBudget, failSave = () => false) {
  const saves: Array<{ run: BudgetTotals; workspace: BudgetTotals }> = [];
  const hook = createComposerBudget({
    run, workspace,
    save: (r, w) => {
      if (failSave()) throw new Error("disk full");
      saves.push({ run: r, workspace: w });
    },
  });
  return { hook, saves };
}

test("an allowed request is written with its reservation before the guard is answered, then settled", async () => {
  const run = createRunBudget({ maxTokens: 1000 });
  const ws = createRunBudget({ maxTokens: 5000 }, { tokens: 400, costMicroUsd: 0, requests: 3, unpricedRequests: 0 });
  const { hook, saves } = rig(run, ws);
  const info = ask();
  assert.deepEqual(await hook.beforeRequest(info), { allow: true });
  assert.deepEqual(saves.at(-1), {
    run: { tokens: 110, costMicroUsd: 0, requests: 1, unpricedRequests: 0 },
    workspace: { tokens: 510, costMicroUsd: 0, requests: 4, unpricedRequests: 0 },
  });
  await hook.recordUsage(settle(info, 7, 20));
  assert.deepEqual(saves.at(-1), {
    // an unpriced settlement is counted on both (so a cost cap set later still fails closed)
    run: { tokens: 27, costMicroUsd: 0, requests: 1, unpricedRequests: 1 },
    workspace: { tokens: 427, costMicroUsd: 0, requests: 4, unpricedRequests: 1 },
  });
  assert.deepEqual(durableTotals(ws), saves.at(-1)?.workspace);
});

test("order: the run is asked first; a run refusal never reaches the workspace and writes nothing", async () => {
  const run = createRunBudget({ maxRequests: 0 });
  let asked = 0;
  const ws = createRunBudget({});
  const spy: RunBudget = { ...ws, beforeRequest: (i) => (asked++, ws.beforeRequest(i)) };
  const { hook, saves } = rig(run, spy);
  assert.deepEqual(await hook.beforeRequest(ask()), { allow: false, reason: "requests" });
  assert.equal(asked, 0);
  assert.equal(saves.length, 0);
});

test("a workspace refusal is prefixed, releases the run's reservation, and the tighter output cap of the two wins", async () => {
  const run = createRunBudget({ maxTokens: 1000 });
  const ws = createRunBudget({ maxTokens: 50 });
  const { hook, saves } = rig(run, ws);
  assert.deepEqual(await hook.beforeRequest(ask({ estimatedInputTokens: 60 })), { allow: false, reason: "workspace_tokens" });
  assert.deepEqual(run.reserved(), { tokens: 0, costMicroUsd: 0, requests: 0 }, "nothing stays reserved on the run");
  assert.equal(saves.length, 0);
  // Both allow: the workspace's smaller headroom clamps the output cap.
  assert.deepEqual(await hook.beforeRequest(ask({ estimatedInputTokens: 10 })), { allow: true, maxOutputTokens: 40 });
  for (const r of BUDGET_REASONS) assert.match(r, /^[a-z_]+$/);
});

test("closed: an unknown reason, a malformed answer or a throwing budget denies state_invalid, and every later request too", async () => {
  const good = () => createRunBudget({});
  const odd = (answer: unknown): RunBudget => ({ ...good(), beforeRequest: () => answer as never });
  const throwing: RunBudget = { ...good(), beforeRequest: () => { throw new Error("boom"); } };
  const cases: Array<[RunBudget, RunBudget, string]> = [
    [odd({ allow: false, reason: "free text from somewhere" }), good(), "state_invalid"],
    [odd({ allow: "yes" }), good(), "state_invalid"],
    [odd({ allow: true, maxOutputTokens: 1.5 }), good(), "state_invalid"],
    [throwing, good(), "state_invalid"],
    [good(), odd({ allow: false, reason: "workspace_tokens" }), "workspace_state_invalid"],
    [good(), odd(null), "workspace_state_invalid"],
    [good(), throwing, "workspace_state_invalid"],
  ];
  for (const [run, ws, reason] of cases) {
    const { hook } = rig(run, ws);
    assert.deepEqual(await hook.beforeRequest(ask()), { allow: false, reason }, reason);
    assert.deepEqual(await hook.beforeRequest(ask()), { allow: false, reason: "state_invalid" }, "poisoned");
  }
});

test("a journal write that fails denies the request, releases both reservations and refuses every later request", async () => {
  const run = createRunBudget({});
  const ws = createRunBudget({});
  let fail = true;
  const { hook } = rig(run, ws, () => fail);
  assert.deepEqual(await hook.beforeRequest(ask()), { allow: false, reason: "state_invalid" });
  assert.deepEqual([run.reserved().tokens, ws.reserved().tokens], [0, 0]);
  fail = false;
  assert.deepEqual(await hook.beforeRequest(ask()), { allow: false, reason: "state_invalid" });
  // A settlement that cannot be written throws (the guard fails the run closed) and poisons the hook.
  const broken = rig(createRunBudget({}), createRunBudget({}), () => fail);
  fail = false;
  const i2 = ask();
  assert.deepEqual(await broken.hook.beforeRequest(i2), { allow: true });
  fail = true;
  await assert.rejects(async () => broken.hook.recordUsage(settle(i2, 1, 1)), /disk full/);
  fail = false;
  assert.deepEqual(await broken.hook.beforeRequest(ask()), { allow: false, reason: "state_invalid" });
});
