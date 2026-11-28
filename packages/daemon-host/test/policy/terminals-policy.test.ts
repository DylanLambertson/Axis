// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.terminals/1 (DC-3a, terminals-contract.md section 1): planned until DC-3c, with one user-only planned row per method at the
// contract's tier (open per-start); never a web client, never a plugin (the deny list), and not served, so every call is unknown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contracts, lookupMethod, plannedContracts, terminalsMethods } from "@axis/protocol";
import { coverageProblems, PLANNED_RULES, RULES } from "../../src/policy/index.js";
import { pluginDenied } from "../../src/policy/plugin-rules.js";
import { WEB_ALLOWED } from "../../src/policy/rule-table-policy.js";

test("axis.terminals/1 is planned, not served: no served row, no registry entry, and a lookup finds nothing", () => {
  assert.equal(contracts["axis.terminals/1"], undefined);
  assert.ok(plannedContracts["axis.terminals/1"] !== undefined);
  for (const method of Object.keys(terminalsMethods)) {
    const key = `axis.terminals/1.${method}`;
    assert.equal(RULES[key], undefined, `${key} is not served`);
    assert.equal(lookupMethod("axis.terminals", 1, method), undefined, `${key} cannot be called`);
  }
  assert.deepEqual(coverageProblems(), []);
});

test("each planned row is the user's alone, at the contract's tier; open is per-start, the rest need no trust", () => {
  for (const [method, spec] of Object.entries(terminalsMethods)) {
    const key = `axis.terminals/1.${method}`;
    assert.deepEqual(PLANNED_RULES[key]?.actors, ["user"], key);
    assert.equal(PLANNED_RULES[key]?.tier, spec.tier, key);
    assert.equal(PLANNED_RULES[key]?.trust, method === "open" ? "per-start" : "none", key);
    assert.equal(WEB_ALLOWED.has(key), false, `${key}: never a web client`);
    assert.equal(pluginDenied(key), true, `${key}: never a plugin`);
  }
  assert.deepEqual([terminalsMethods.open.tier, terminalsMethods.list.tier, terminalsMethods.close.tier, terminalsMethods.attach.tier], [2, 0, 2, 2]);
});
