// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Rows for the methods of PLANNED contracts (`plannedContracts` in `@axis/protocol`): agreed schemas that no host serves
// yet. They are NOT served rules: `RuleTablePolicy` never sees them, so the policy denies them like any unknown method.
// `checkCoverage` requires exactly one row per planned method at the contract's tier, fails on a row for anything else,
// and fails once a planned key is served (move its line to rules.ts in the change that registers the handlers). One line
// per method.
//
// None is planned now: axis.forge/1 moved to rules.ts with PV-D2 slice 2, axis.agents/1 and axis.agent-groups/1 with PV-G3.
import type { Rule } from "./rule-types.js";

export const PLANNED_RULES: Readonly<Record<string, Rule>> = Object.freeze({
});
