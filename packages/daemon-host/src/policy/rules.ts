// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The served rule table (design 4.2): ONE LINE PER METHOD so tickets that add a method conflict on a single line at most.
// A method with no row is denied (invariant I2), and `checkCoverage` fails the test run and host startup when the
// protocol registry and this table disagree in either direction. To add a method: add it to its contract, add its line
// here (the tier must equal the contract's declared minimum), add its handler.
//
// axis.messages/1 (PV-M3, moved from planned.ts with its handlers). Every read method has its own row (review B1): the row
// admits the caller, and the message service then answers only for threads the caller participates in, with `not_found`
// for every other (docs/design/inter-agent-communication.md section 4.2). The rows are user only: agent and CLI callers
// reach messaging through the broker (PV-M4) and the endpoint (PV-M6), not the bridge; a bridge row for them needs a new
// actor kind and a new review. None is in WEB_ALLOWED.
import { userRule, type Rule } from "./rule-types.js";

export const RULES: Readonly<Record<string, Rule>> = Object.freeze({
  "axis.worktrees/1.list": userRule(0),
  "axis.worktrees/1.status": userRule(0),
  "axis.worktrees/1.create": userRule(2, "registry"),
  "axis.worktrees/1.finalise": userRule(4),
  "axis.worktrees/1.remove": userRule(4),
  "axis.worktrees/1.restoreFromRunBase": userRule(2, "registry"),
  "axis.worktrees/1.discard": userRule(2, "registry"),
  "axis.worktrees/1.setUserEditing": userRule(2),
  "axis.projects/1.list": userRule(0),
  "axis.approvals/1.resolve": userRule(2),
  "axis.approvals/1.pending": userRule(0),
  "axis.audit/1.status": userRule(0),
  "axis.audit/1.list": userRule(1),
  "axis.audit/1.verify": userRule(1),
  "axis.cli-runs/1.start": userRule(2, "per-start"),
  "axis.cli-runs/1.stop": userRule(2),
  "axis.cli-runs/1.get": userRule(0),
  "axis.cli-runs/1.list": userRule(0),
  "axis.providers/1.list": userRule(0),
  "axis.git/1.pushPlan": userRule(1),
  "axis.git/1.commit": userRule(2, "registry"),
  "axis.git/1.push": userRule(4, "registry"),
  "axis.git/1.compareUrl": userRule(0),
  "axis.review/1.diff": userRule(1),
  "axis.review/1.content": userRule(1),
  "axis.review/1.complete": userRule(2),
  "axis.runs/1.start": userRule(2, "registry"),
  "axis.runs/1.cancel": userRule(2),
  "axis.runs/1.get": userRule(0),
  "axis.runs/1.list": userRule(0),
  "axis.runs/1.events": userRule(0),
  "axis.events/1.subscribe": userRule(0),
  "axis.events/1.unsubscribe": userRule(0),
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
