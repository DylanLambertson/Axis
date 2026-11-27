// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.integrations/1 split by method (PV-N1f read slice, net-read-slice.md §6): list, status and read are served user rows at
// tier 0, read gated on project trust; connect, disconnect and write stay planned rows at their tiers; axis.net/1 stays wholly
// planned. None is web-allowed, and no plugin rule names either contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contracts, integrationsMethods, netMethods, plannedContracts } from "@axis/protocol";
import { coverageProblems, PLANNED_RULES, RULES, WEB_ALLOWED } from "../../src/policy/index.js";
import { PLUGIN_METHOD_SETS } from "../../src/policy/plugin-rules.js";

const SERVED = ["list", "status", "read"] as const;
const PLANNED = ["connect", "disconnect", "write"] as const;

test("list, status and read are served user rows at the contract tier; read is gated on project trust", () => {
  for (const m of SERVED) {
    const key = `axis.integrations/1.${m}`;
    assert.deepEqual(RULES[key]?.actors, ["user"], key);
    assert.equal(RULES[key]?.tier, integrationsMethods[m].tier, key);
    assert.equal(RULES[key]?.tier, 0, key);
    assert.equal(PLANNED_RULES[key], undefined, `${key} is no longer planned`);
    assert.equal(WEB_ALLOWED.has(key), false, `${key} is not web-allowed`);
  }
  assert.equal(RULES["axis.integrations/1.read"]?.trust, "project", "read reaches the network: the project trust gate first");
  assert.equal(RULES["axis.integrations/1.list"]?.trust, "none", "list reveals and sends nothing");
  assert.equal(RULES["axis.integrations/1.status"]?.trust, "none", "status reveals and sends nothing");
  assert.deepEqual(coverageProblems(), []);
});

test("connect, disconnect, write and all of axis.net/1 stay planned user rows at the contract tiers, none served", () => {
  const planned: Array<[string, string, number]> = [
    ...PLANNED.map((m) => ["axis.integrations/1", m, integrationsMethods[m].tier] as [string, string, number]),
    ...Object.entries(netMethods).map(([m, s]) => ["axis.net/1", m, s.tier] as [string, string, number]),
  ];
  for (const [contract, method, tier] of planned) {
    const key = `${contract}.${method}`;
    assert.equal(RULES[key], undefined, `${key} has no served rule`);
    assert.deepEqual(PLANNED_RULES[key]?.actors, ["user"], key);
    assert.equal(PLANNED_RULES[key]?.tier, tier, key);
    assert.equal(PLANNED_RULES[key]?.trust, "none", key);
    assert.equal(WEB_ALLOWED.has(key), false, `${key} is not web-allowed`);
    assert.equal(Object.hasOwn(contracts[contract] ?? {}, method), false, `${key} is not in the served registry`);
    assert.equal(Object.hasOwn(plannedContracts[contract] ?? {}, method), true, `${key} is in the planned registry`);
  }
  assert.equal(PLANNED_RULES["axis.integrations/1.connect"]?.tier, 4, "connect stores a credential: tier 4, a challenge confirmed in main's native dialog");
  assert.equal(PLANNED_RULES["axis.integrations/1.write"]?.tier, 3);
  assert.equal(PLANNED_RULES["axis.integrations/1.request"], undefined, "the one request method is split");
  assert.equal(PLANNED_RULES["axis.net/1.request"], undefined, "the one request method is split");
});

test("the rows of these contracts are exactly one per method, served or planned", () => {
  const of = (o: Readonly<Record<string, unknown>>) => Object.keys(o).filter((k) => k.startsWith("axis.integrations/") || k.startsWith("axis.net/")).sort();
  assert.deepEqual(of(RULES), ["axis.integrations/1.list", "axis.integrations/1.read", "axis.integrations/1.status"]);
  assert.deepEqual(of(PLANNED_RULES), ["axis.integrations/1.connect", "axis.integrations/1.disconnect", "axis.integrations/1.write", "axis.net/1.read", "axis.net/1.send"]);
});

test("no plugin permission grants a method of axis.integrations/1 or axis.net/1: a plugin caller is refused", () => {
  const keys = Object.values(PLUGIN_METHOD_SETS).flat();
  assert.ok(keys.length > 0, "the plugin allow-list is read");
  assert.deepEqual(keys.filter((k) => k.startsWith("axis.integrations/") || k.startsWith("axis.net/")), []);
});
