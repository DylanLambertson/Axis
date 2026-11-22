// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.integrations/1 and axis.net/1 (PV-N1a): planned, never served. One user-only planned row per method at the contract's tier,
// none served or web-allowed, so the policy denies every call until PV-N1f registers the handlers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contracts, integrationsMethods, netMethods, plannedContracts } from "@axis/protocol";
import { coverageProblems, PLANNED_RULES, RULES, WEB_ALLOWED } from "../../src/policy/index.js";

test("every method of both planned contracts has one planned user-only row at the contract's tier, none served or web-allowed", () => {
  for (const [contract, methods] of [["axis.integrations/1", integrationsMethods], ["axis.net/1", netMethods]] as const) {
    assert.ok(plannedContracts[contract] !== undefined, `${contract} is planned`);
    assert.equal(contracts[contract], undefined, `${contract} is not served`);
    for (const [method, spec] of Object.entries(methods)) {
      const key = `${contract}.${method}`;
      assert.equal(RULES[key], undefined, `${key} has no served rule`);
      assert.deepEqual(PLANNED_RULES[key]?.actors, ["user"], key);
      assert.equal(PLANNED_RULES[key]?.tier, spec.tier, key);
      assert.equal(PLANNED_RULES[key]?.trust, "none", key);
      assert.equal(WEB_ALLOWED.has(key), false, `${key} is not web-allowed`);
    }
  }
  assert.equal(PLANNED_RULES["axis.integrations/1.connect"]?.tier, 3, "connect stores a credential: tier 3");
  assert.deepEqual(coverageProblems(), []);
});

test("the planned rows of these contracts are exactly one per method", () => {
  assert.deepEqual(Object.keys(PLANNED_RULES).filter((k) => k.startsWith("axis.integrations/") || k.startsWith("axis.net/")).sort(), [
    "axis.integrations/1.connect", "axis.integrations/1.disconnect", "axis.integrations/1.list", "axis.integrations/1.request", "axis.integrations/1.status", "axis.net/1.request",
  ]);
});
