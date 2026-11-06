// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Rows for methods the design names that no protocol contract serves yet (none at present: `axis.git/1` and `axis.review/1`
// were promoted to rules.ts by P1b, `discard` and `setUserEditing` by P1d). They are NOT served rules: the policy denies them like any unknown method, and
// `checkCoverage` fails if a planned key is already registered (move its line to rules.ts in the same change that
// adds the contract) or if it also appears in the served table. One line per method.
import type { Rule } from "./rule-types.js";

export const PLANNED_RULES: Readonly<Record<string, Rule>> = Object.freeze({});
