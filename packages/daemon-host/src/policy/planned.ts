// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Rows for the methods of PLANNED contracts (`plannedContracts` in `@axis/protocol`): agreed schemas that no host serves
// yet. They are NOT served rules: `RuleTablePolicy` never sees them, so the policy denies them like any unknown method.
// `checkCoverage` requires exactly one row per planned method at the contract's tier, fails on a row for anything else,
// and fails once a planned key is served (move its line to rules.ts in the change that registers the handlers). One line
// per method.
//
// axis.agents/1 and axis.agent-groups/1 (PV-G2, ADR 0006 decision 10): user only, reads included. No agent, plugin or
// message creates, changes or groups an agent: group membership feeds the messaging send policy (`accepts_from: group`).
// (axis.forge/1 moved to rules.ts with PV-D2 slice 2.)
//
// axis.pages/1 (PV-Q1 slice 1, ADR 0010): user only. Marking a version reviewed lowers taint and needs main's native
// confirmation (tier 3); delete is destructive (tier 3). Agents and plugins reach pages through their own tools and rows.
import { userRule, type Rule } from "./rule-types.js";

export const PLANNED_RULES: Readonly<Record<string, Rule>> = Object.freeze({
  "axis.agents/1.list": userRule(0),
  "axis.agents/1.get": userRule(0),
  "axis.agents/1.create": userRule(2),
  "axis.agents/1.update": userRule(2),
  "axis.agents/1.archive": userRule(1),
  "axis.agents/1.restore": userRule(1),
  "axis.agent-groups/1.list": userRule(0),
  "axis.agent-groups/1.create": userRule(1),
  "axis.agent-groups/1.rename": userRule(1),
  "axis.agent-groups/1.reorder": userRule(1),
  "axis.agent-groups/1.delete": userRule(1),
  "axis.agent-groups/1.assign": userRule(2),
  "axis.pages/1.list": userRule(0),
  "axis.pages/1.get": userRule(0),
  "axis.pages/1.versions": userRule(0),
  "axis.pages/1.create": userRule(1),
  "axis.pages/1.update": userRule(1),
  "axis.pages/1.restore": userRule(1),
  "axis.pages/1.markReviewed": userRule(3),
  "axis.pages/1.delete": userRule(3),
});
