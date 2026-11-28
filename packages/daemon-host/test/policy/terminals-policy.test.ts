// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.terminals/1 (DC-3a, served with DC-3c; terminals-contract.md section 1): one served, user-only row per method at the
// contract's tier (open per-start, tiers 2/0/2/2), none planned; never a web client, never a plugin (the deny list).
import { test } from "node:test";
import assert from "node:assert/strict";
import { contracts, lookupMethod, plannedContracts, terminalsMethods } from "@axis/protocol";
import { coverageProblems, PLANNED_RULES, RULES } from "../../src/policy/index.js";
import { pluginDenied } from "../../src/policy/plugin-rules.js";
import { WEB_ALLOWED } from "../../src/policy/rule-table-policy.js";

test("axis.terminals/1 is served: in the registry, not planned, and each method has its row", () => {
  assert.ok(contracts["axis.terminals/1"] !== undefined);
  assert.equal(plannedContracts["axis.terminals/1"], undefined);
  for (const method of Object.keys(terminalsMethods)) {
    const key = `axis.terminals/1.${method}`;
    assert.equal(PLANNED_RULES[key], undefined, `${key} is not planned`);
    assert.ok(lookupMethod("axis.terminals", 1, method) !== undefined, key);
  }
  assert.deepEqual(coverageProblems(), []);
});

test("each row is the user's alone, at the contract's tier; open is per-start, the rest need no trust; never web, never a plugin", () => {
  for (const [method, spec] of Object.entries(terminalsMethods)) {
    const key = `axis.terminals/1.${method}`;
    assert.deepEqual(RULES[key]?.actors, ["user"], key);
    assert.equal(RULES[key]?.tier, spec.tier, key);
    assert.equal(RULES[key]?.trust, method === "open" ? "per-start" : "none", key);
    assert.equal(WEB_ALLOWED.has(key), false, `${key}: never a web client`);
    assert.equal(pluginDenied(key), true, `${key}: never a plugin`);
  }
  assert.deepEqual([terminalsMethods.open.tier, terminalsMethods.list.tier, terminalsMethods.close.tier, terminalsMethods.attach.tier], [2, 0, 2, 2]);
});
