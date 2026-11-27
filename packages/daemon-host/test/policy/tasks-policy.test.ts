// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.tasks/1 (PV-T1 slices 1 and 2a): served, user-only rows at the contract's tiers; the wire limits are the journal's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TASK_LIMITS } from "@axis/journal";
import { MAX_TASK_BODY_CHARS, MAX_TASK_LINKS, MAX_TASK_REVISIONS, MAX_TASKS_PER_PROJECT, contracts, plannedContracts, tasksMethods } from "@axis/protocol";
import { coverageProblems, PLANNED_RULES, RULES } from "../../src/policy/index.js";

test("every method has one served, user-only row at the contract's tier, none is planned; only Start is gated on the project's trust", () => {
  assert.ok(contracts["axis.tasks/1"] !== undefined);
  assert.equal(plannedContracts["axis.tasks/1"], undefined);
  for (const [method, spec] of Object.entries(tasksMethods)) {
    const key = `axis.tasks/1.${method}`;
    assert.equal(PLANNED_RULES[key], undefined, `${key} is not a planned rule`);
    assert.deepEqual(RULES[key]?.actors, ["user"], key);
    assert.equal(RULES[key]?.tier, spec.tier, key);
    assert.equal(RULES[key]?.trust, method === "start" ? "project" : "none", key);
  }
  assert.equal(RULES["axis.tasks/1.delete"]?.tier, 4);
  assert.equal(RULES["axis.tasks/1.start"]?.tier, 4);
  assert.deepEqual(coverageProblems(), []);
});

test("the wire limits are the journal's", () => {
  assert.equal(MAX_TASKS_PER_PROJECT, TASK_LIMITS.tasksPerProject);
  assert.equal(MAX_TASK_REVISIONS, TASK_LIMITS.revisionsPerTask);
  assert.equal(MAX_TASK_LINKS, TASK_LIMITS.linksPerTask);
  assert.equal(MAX_TASK_BODY_CHARS, TASK_LIMITS.bodyChars);
});
