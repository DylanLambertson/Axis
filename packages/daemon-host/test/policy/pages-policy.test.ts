// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// axis.pages/1 (PV-Q1 slices 1 and 2): served, user-only rows at the contract's tiers; the wire title rule is exactly the
// journal's (schema version 14) inside a title, so a title the wire accepts is one the journal stores.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NAME_REFUSED_RANGES, PAGE_LIMITS } from "@axis/journal";
import {
  MAX_PAGE_BODY_BYTES, MAX_PAGES_PER_PROJECT, MAX_PAGE_VERSIONS, PAGE_TITLE_CHARS, contracts, pageTitleSchema, pagesMethods, plannedContracts,
} from "@axis/protocol";
import { coverageProblems, PLANNED_RULES, RULES } from "../../src/policy/index.js";

test("every method has one served, user-only row at the contract's tier, with no trust mode, and none is still planned", () => {
  assert.ok(contracts["axis.pages/1"] !== undefined);
  assert.equal(plannedContracts["axis.pages/1"], undefined);
  for (const [method, spec] of Object.entries(pagesMethods)) {
    const key = `axis.pages/1.${method}`;
    assert.equal(PLANNED_RULES[key], undefined, `${key} is not planned`);
    assert.deepEqual(RULES[key]?.actors, ["user"], key);
    assert.equal(RULES[key]?.tier, spec.tier, key);
    assert.equal(RULES[key]?.trust, "none", key);
  }
  assert.equal(RULES["axis.pages/1.markReviewed"]?.tier, 3);
  assert.equal(RULES["axis.pages/1.delete"]?.tier, 3);
  assert.deepEqual(coverageProblems(), []);
});

test("the wire limits are the journal's", () => {
  assert.equal(MAX_PAGES_PER_PROJECT, PAGE_LIMITS.pagesPerProject);
  assert.equal(MAX_PAGE_VERSIONS, PAGE_LIMITS.versionsPerPage);
  assert.equal(MAX_PAGE_BODY_BYTES, PAGE_LIMITS.bodyBytes);
  assert.equal(PAGE_TITLE_CHARS, PAGE_LIMITS.titleChars);
});

test("the wire title rule refuses exactly the journal's code points plus NUL, over every code point", () => {
  const spans = NAME_REFUSED_RANGES.map((r) => (typeof r === "number" ? [r, r] : r));
  const journalRefuses = (cp: number): boolean => cp === 0 || spans.some(([a, b]) => cp >= a! && cp <= b!);
  const differ: string[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const wireRefuses = !pageTitleSchema.safeParse(`a${String.fromCodePoint(cp)}b`).success;
    if (wireRefuses !== journalRefuses(cp)) differ.push(`U+${cp.toString(16)}`);
    if (differ.length > 20) break;
  }
  assert.deepEqual(differ, []);
});
