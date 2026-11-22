// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Rows for the methods of PLANNED contracts (`plannedContracts` in `@axis/protocol`): agreed schemas that no host serves
// yet. They are NOT served rules: `RuleTablePolicy` never sees them, so the policy denies them like any unknown method.
// `checkCoverage` requires exactly one row per planned method at the contract's tier, fails on a row for anything else,
// and fails once a planned key is served (move its line to rules.ts in the change that registers the handlers). One line
// per method.
//
// axis.integrations/1 and axis.net/1 (PV-N1a, ADR 0009 decisions 1 to 4): user rows at the contract tiers, because `RuleActor` has
// no other actor yet. `connect` is user-only for good (a plugin's `integration:<id>` grant never includes it). The plugin
// allow-list rows (ADR 0008 decision 6: `net:<origin>`, `integration:<id>`) are PV-K1's; `axis.net/1.read` and `.send` are plugin
// methods, so when they are served (PV-N1f with PV-K1) these user rows are replaced by those rows and a user caller is refused.
// (axis.forge/1 moved to rules.ts with PV-D2 slice 2, axis.agents/1 and axis.agent-groups/1 with PV-G3, axis.pages/1 with PV-Q1 slice 2.)
import { userRule, type Rule } from "./rule-types.js";

export const PLANNED_RULES: Readonly<Record<string, Rule>> = Object.freeze({
  "axis.integrations/1.list": userRule(0),
  "axis.integrations/1.status": userRule(0),
  "axis.integrations/1.connect": userRule(3),
  "axis.integrations/1.disconnect": userRule(1),
  "axis.integrations/1.read": userRule(0),
  "axis.integrations/1.write": userRule(3),
  "axis.net/1.read": userRule(0),
  "axis.net/1.send": userRule(3),
});
