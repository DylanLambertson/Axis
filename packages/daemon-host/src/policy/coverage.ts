// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { contracts } from "@axis/protocol";
import { PLANNED_RULES } from "./planned.js";
import { RULES } from "./rules.js";
import type { Rule } from "./rule-types.js";

type Registry = Readonly<Record<string, Readonly<Record<string, { readonly tier: number }>>>>;

export interface CoverageInput {
  /** The protocol registry (defaults to the one this build serves). */
  readonly registry?: Registry;
  readonly rules?: Readonly<Record<string, Rule>>;
  readonly planned?: Readonly<Record<string, Rule>>;
  /** Further sets that must equal the served set (handlers, audit action declarations), added by later tickets. */
  readonly also?: Readonly<Record<string, ReadonlySet<string>>>;
}

/** Every `<contract>/<major>.<method>` the registry serves, with its declared tier. */
export function servedMethods(registry: Registry = contracts): Map<string, number> {
  const out = new Map<string, number>();
  for (const [contract, methods] of Object.entries(registry)) {
    for (const [name, spec] of Object.entries(methods)) out.set(`${contract}.${name}`, spec.tier);
  }
  return out;
}

/** Every disagreement between the served registry, the rule table and the planned rows. Empty means covered. */
export function coverageProblems(input: CoverageInput = {}): string[] {
  const served = servedMethods(input.registry);
  const rules = new Map(Object.entries(input.rules ?? RULES));
  const planned = new Map(Object.entries(input.planned ?? PLANNED_RULES));
  const out: string[] = [];
  for (const [key, tier] of served) {
    const rule = rules.get(key);
    if (rule === undefined) out.push(`${key}: served but has no policy rule`);
    else if (rule.tier !== tier) out.push(`${key}: rule tier ${rule.tier} differs from the contract tier ${tier}`);
  }
  for (const key of rules.keys()) if (!served.has(key)) out.push(`${key}: policy rule for no served method`);
  for (const key of planned.keys()) {
    if (served.has(key)) out.push(`${key}: planned but already served (move its row to the served table)`);
    if (rules.has(key)) out.push(`${key}: in both the served table and the planned table`);
  }
  for (const [name, set] of Object.entries(input.also ?? {})) {
    for (const key of served.keys()) if (!set.has(key)) out.push(`${key}: served but missing from ${name}`);
    for (const key of set) if (!served.has(key)) out.push(`${key}: in ${name} but not served`);
  }
  return out.sort();
}

/** Throws when the table and the registry disagree. Called at startup (design 10) and by the unit test. */
export function checkCoverage(input: CoverageInput = {}): void {
  const problems = coverageProblems(input);
  if (problems.length > 0) throw new Error(`policy coverage: ${problems.join("; ")}`);
}
