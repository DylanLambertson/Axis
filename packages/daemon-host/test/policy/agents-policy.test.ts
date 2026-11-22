// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.agents/1 and axis.agent-groups/1 (PV-G2): planned, user-only rows at the contract tiers; the protocol's name rule is
// exactly the journal's (schema version 12) inside a name, so a name the wire accepts is one the journal stores. At the edges
// the wire is stricter (it refuses any leading or trailing whitespace, the journal only spaces): the safe direction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NAME_REFUSED_RANGES } from "@axis/journal";
import { agentGroupsMethods, agentNameSchema, agentsMethods, contracts, plannedContracts } from "@axis/protocol";
import { coverageProblems, PLANNED_RULES, RULES } from "../../src/policy/index.js";

test("every method of both contracts has one planned, user-only row at the contract's tier, and none is served", () => {
  for (const [contract, methods] of [["axis.agents/1", agentsMethods], ["axis.agent-groups/1", agentGroupsMethods]] as const) {
    assert.equal(contracts[contract], undefined, `${contract} is not served`);
    assert.ok(plannedContracts[contract] !== undefined, `${contract} is planned`);
    for (const [method, spec] of Object.entries(methods)) {
      const key = `${contract}.${method}`;
      assert.equal(RULES[key], undefined, `${key} is not a served rule`);
      assert.deepEqual(PLANNED_RULES[key]?.actors, ["user"], key);
      assert.equal(PLANNED_RULES[key]?.tier, spec.tier, key);
      assert.equal(PLANNED_RULES[key]?.trust, "none", key);
    }
  }
  assert.deepEqual(coverageProblems(), []);
});

test("the wire name rule refuses exactly the journal's code points plus NUL, over every code point", () => {
  const spans = NAME_REFUSED_RANGES.map((r) => (typeof r === "number" ? [r, r] : r));
  const journalRefuses = (cp: number): boolean => cp === 0 || spans.some(([a, b]) => cp >= a! && cp <= b!);
  const differ: string[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue; // a lone surrogate is not text the journal can hold; the wire refuses it (Cs)
    const wireRefuses = !agentNameSchema.safeParse(`a${String.fromCodePoint(cp)}b`).success;
    if (wireRefuses !== journalRefuses(cp)) differ.push(`U+${cp.toString(16)}`);
    if (differ.length > 20) break;
  }
  assert.deepEqual(differ, []);
  assert.equal(agentNameSchema.safeParse("a\ud800b").success, false);
});
