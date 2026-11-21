// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Rows for the methods of PLANNED contracts (`plannedContracts` in `@axis/protocol`): agreed schemas that no host serves
// yet. They are NOT served rules: `RuleTablePolicy` never sees them, so the policy denies them like any unknown method.
// `checkCoverage` requires exactly one row per planned method at the contract's tier, fails on a row for anything else,
// and fails once a planned key is served (move its line to rules.ts in the change that registers the handlers). One line
// per method.
//
// axis.messages/1 (PV-M1; served by PV-M3). Every read method has its own row (review B1): the row admits the caller,
// and the message service then answers only for threads the caller participates in, with `not_found` for every other
// (docs/design/inter-agent-communication.md section 4.2). Agent and CLI callers reach messaging through the broker
// (PV-M4) and the endpoint (PV-M6), not the bridge; a bridge row for them needs a new actor kind and a new review.
import { userRule, type Rule } from "./rule-types.js";

export const PLANNED_RULES: Readonly<Record<string, Rule>> = Object.freeze({
  "axis.messages/1.send": userRule(2),
  "axis.messages/1.thread": userRule(1),
  "axis.messages/1.threads": userRule(0),
  "axis.messages/1.read": userRule(1),
  "axis.messages/1.markRead": userRule(1),
  "axis.messages/1.pause": userRule(2),
  "axis.messages/1.resume": userRule(2),
  "axis.messages/1.settings": userRule(0),
  "axis.messages/1.updateSettings": userRule(2),
});
