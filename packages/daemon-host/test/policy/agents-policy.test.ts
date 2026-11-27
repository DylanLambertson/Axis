// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.agents/1 and axis.agent-groups/1 (PV-G2, served by PV-G3): user-only rows at the contract tiers; the protocol's name rule is
// exactly the journal's (schema version 12) inside a name, so a name the wire accepts is one the journal stores. At the edges
// the wire is stricter (it refuses any leading or trailing whitespace, the journal only spaces): the safe direction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NAME_REFUSED_RANGES } from "@axis/journal";
import { agentGroupsMethods, agentNameSchema, agentsMethods, contracts, plannedContracts } from "@axis/protocol";
import { coverageProblems, PLANNED_RULES, RULES, WEB_ALLOWED } from "../../src/policy/index.js";

test("every method of both contracts has one served, user-only row at the contract's tier, none planned or web-allowed", () => {
  for (const [contract, methods] of [["axis.agents/1", agentsMethods], ["axis.agent-groups/1", agentGroupsMethods]] as const) {
    assert.ok(contracts[contract] !== undefined, `${contract} is served`);
    assert.equal(plannedContracts[contract], undefined, `${contract} is not planned`);
    for (const [method, spec] of Object.entries(methods)) {
      const key = `${contract}.${method}`;
      assert.equal(PLANNED_RULES[key], undefined, `${key} is not planned`);
      assert.deepEqual(RULES[key]?.actors, ["user"], key);
      assert.equal(RULES[key]?.tier, spec.tier, key);
      assert.equal(RULES[key]?.trust, key === "axis.agents/1.start" ? "project" : "none", key); // start: the gate decides in the handler
      assert.equal(WEB_ALLOWED.has(key), false, `${key} is not web-allowed`);
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
