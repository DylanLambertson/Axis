// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Rows for methods the design names that no protocol contract serves yet (axis.git/1 and axis.review/1: ticket P1b;
// discard and setUserEditing: P1d). They are NOT served rules: the policy denies them like any unknown method, and
// `checkCoverage` fails if a planned key is already registered (move its line to rules.ts in the same change that
// adds the contract) or if it also appears in the served table. One line per method.
import { userRule, type Rule } from "./rule-types.js";

export const PLANNED_RULES: Readonly<Record<string, Rule>> = Object.freeze({
  "axis.worktrees/1.discard": userRule(2),
  "axis.worktrees/1.setUserEditing": userRule(2),
  "axis.review/1.diff": userRule(1),
  "axis.review/1.complete": userRule(2),
  "axis.git/1.pushPlan": userRule(1),
  "axis.git/1.commit": userRule(2, "registry"),
  "axis.git/1.push": userRule(4, "registry"),
  "axis.git/1.compareUrl": userRule(0),
});
