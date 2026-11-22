// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.tasks/1 (PV-T1 slice 1): planned, user-only rows at the contract's tiers; the wire limits are the journal's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TASK_LIMITS } from "@axis/journal";
import { MAX_TASK_BODY_CHARS, MAX_TASK_LINKS, MAX_TASK_REVISIONS, MAX_TASKS_PER_PROJECT, contracts, plannedContracts, tasksMethods } from "@axis/protocol";
import { coverageProblems, PLANNED_RULES, RULES } from "../../src/policy/index.js";

test("every method has one planned, user-only row at the contract's tier, with no trust mode, and none is served", () => {
  assert.equal(contracts["axis.tasks/1"], undefined);
  assert.ok(plannedContracts["axis.tasks/1"] !== undefined);
  for (const [method, spec] of Object.entries(tasksMethods)) {
    const key = `axis.tasks/1.${method}`;
    assert.equal(RULES[key], undefined, `${key} is not a served rule`);
    assert.deepEqual(PLANNED_RULES[key]?.actors, ["user"], key);
    assert.equal(PLANNED_RULES[key]?.tier, spec.tier, key);
    assert.equal(PLANNED_RULES[key]?.trust, "none", key);
  }
  assert.equal(PLANNED_RULES["axis.tasks/1.delete"]?.tier, 3);
  assert.deepEqual(coverageProblems(), []);
});

test("the wire limits are the journal's", () => {
  assert.equal(MAX_TASKS_PER_PROJECT, TASK_LIMITS.tasksPerProject);
  assert.equal(MAX_TASK_REVISIONS, TASK_LIMITS.revisionsPerTask);
  assert.equal(MAX_TASK_LINKS, TASK_LIMITS.linksPerTask);
  assert.equal(MAX_TASK_BODY_CHARS, TASK_LIMITS.bodyChars);
});
