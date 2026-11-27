// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { contracts, plannedContracts } from "@axis/protocol";
import { PLANNED_RULES } from "./planned.js";
import { RULES } from "./rules.js";
import type { Rule } from "./rule-types.js";

type Registry = Readonly<Record<string, Readonly<Record<string, { readonly tier: number }>>>>;

export interface CoverageInput {
  /**
   * The protocol registry (defaults to the one this build serves). If it is filtered by `config.contracts`, `rules`
   * and `planned` must be filtered the same way: use `policySurface(ids)`, which does all three together.
   */
  readonly registry?: Registry;
  readonly rules?: Readonly<Record<string, Rule>>;
  readonly planned?: Readonly<Record<string, Rule>>;
  /** The planned contracts (defaults to `plannedContracts`): each of their methods needs a planned row at the same tier. */
  readonly plannedRegistry?: Registry;
  /** Further sets that must equal the served set (handlers, audit action declarations), added by later tickets. */
  readonly also?: Readonly<Record<string, ReadonlySet<string>>>;
  /**
   * The registered methods whose handler is marked `projectGated` (project-registration-and-trust.md §5.4). When given, it must be
   * exactly the served rows whose trust mode is `project` or `per-start`: a gated row with a plain handler, or a marked handler on
   * another row, is a problem.
   */
  readonly gated?: ReadonlySet<string>;
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
  const plannedMethods = servedMethods(input.plannedRegistry ?? plannedContracts);
  for (const [key, tier] of plannedMethods) {
    const row = planned.get(key);
    if (row === undefined) out.push(`${key}: planned method has no planned rule`);
    else if (row.tier !== tier) out.push(`${key}: planned rule tier ${row.tier} differs from the contract tier ${tier}`);
    if (served.has(key)) out.push(`${key}: in both the served and the planned registry`);
  }
  for (const key of planned.keys()) {
    if (served.has(key)) out.push(`${key}: planned but already served (move its row to the served table)`);
    else if (!plannedMethods.has(key)) out.push(`${key}: planned rule for no planned method`);
    if (rules.has(key)) out.push(`${key}: both a served and a planned rule`);
  }
  if (input.gated !== undefined) {
    for (const key of served.keys()) {
      const trust = rules.get(key)?.trust;
      const wants = trust === "project" || trust === "per-start";
      if (wants && !input.gated.has(key)) out.push(`${key}: a gated row registered without the project trust gate`);
      if (!wants && input.gated.has(key)) out.push(`${key}: a gated handler on a row that is not gated`);
    }
    for (const key of input.gated) if (!served.has(key)) out.push(`${key}: gated but not served`);
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

export interface PolicySurface {
  readonly registry: Registry;
  readonly rules: Readonly<Record<string, Rule>>;
  readonly planned: Readonly<Record<string, Rule>>;
  readonly plannedRegistry: Registry;
}

/**
 * The registry, rule table, planned table and planned registry restricted to the contract ids the host serves (`config.contracts`;
 * absent means all), so they cannot diverge. Pass `surface.rules` to `RuleTablePolicy` and the whole surface to
 * `checkCoverage`. A rule key is `<id>/<major>.<method>`, so it belongs to a contract id when it starts `<id>/`.
 */
export function policySurface(contractIds?: readonly string[]): PolicySurface {
  if (contractIds === undefined) return { registry: contracts, rules: RULES, planned: PLANNED_RULES, plannedRegistry: plannedContracts };
  const ids = new Set(contractIds);
  const keep = (key: string): boolean => ids.has(key.slice(0, key.indexOf("/")));
  const pick = <T>(o: Readonly<Record<string, T>>, f: (k: string) => boolean): Readonly<Record<string, T>> =>
    Object.freeze(Object.fromEntries(Object.entries(o).filter(([k]) => f(k))));
  return {
    registry: pick(contracts, (k) => ids.has(k.slice(0, k.indexOf("/")))),
    rules: pick(RULES, keep),
    planned: pick(PLANNED_RULES, keep),
    plannedRegistry: pick(plannedContracts, (k) => ids.has(k.slice(0, k.indexOf("/")))),
  };
}
