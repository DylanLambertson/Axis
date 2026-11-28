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
//
// axis.forge/1 (PV-D2 slice 2, moved from planned.ts with its handlers; docs/design/forge-pr-list.md): user only. The list is
// shown on the user's dashboard and never handed to an agent or model in v1 (§5); confirming the repository is the user's own
// act (§2). Neither is in WEB_ALLOWED.
//
// axis.agents/1 and axis.agent-groups/1 (PV-G3, moved from planned.ts with their handlers; ADR 0006 decision 10): user only,
// reads included. No agent, plugin or message creates, changes or groups an agent: group membership feeds the messaging
// send policy (`accepts_from: group`). `create` checks trust in its handler when it makes a worktree (the row cannot: a
// create with an existing home needs none); none is in WEB_ALLOWED.
//
// axis.attention/1 (PV-D4): user only. The needs-attention counts of a project are the user's home view, never an agent's;
// not in WEB_ALLOWED.
//
// axis.usage/1 (PV-D3): user only. Usage, cost and budget left are the user's home view (money), never an agent's; not in
// WEB_ALLOWED.
import { userRule, type Rule } from "./rule-types.js";

export const RULES: Readonly<Record<string, Rule>> = Object.freeze({
  "axis.worktrees/1.list": userRule(0),
  "axis.worktrees/1.status": userRule(0),
  "axis.worktrees/1.create": userRule(2, "project"),
  "axis.worktrees/1.finalise": userRule(4),
  "axis.worktrees/1.remove": userRule(4),
  "axis.worktrees/1.restoreFromRunBase": userRule(2, "project"),
  "axis.worktrees/1.discard": userRule(2, "project"),
  "axis.worktrees/1.setUserEditing": userRule(2),
  "axis.projects/1.list": userRule(0),
  "axis.approvals/1.resolve": userRule(2),
  "axis.approvals/1.pending": userRule(0),
  "axis.approvals/1.detail": userRule(0), // PV-K1e-a2: never a web client (WEB_ALLOWED) or a plugin (the deny list)
  // PV-K2 K2-g1: the user's view of a project's plugins and the two decreases; never a web client (WEB_ALLOWED) or a plugin
  // (`axis.plugins/` is on the plugin deny list).
  "axis.plugins/1.list": userRule(0),
  "axis.plugins/1.revoke": userRule(2),
  "axis.plugins/1.disable": userRule(2),
  // PV-K2 K2-g2: the increases, at tier 4 (a native confirmation); off in production until K2-enable (`pluginGrants`).
  "axis.plugins/1.grant": userRule(4),
  "axis.plugins/1.enable": userRule(4),
  "axis.audit/1.status": userRule(0),
  "axis.audit/1.list": userRule(1),
  "axis.audit/1.verify": userRule(1),
  "axis.cli-runs/1.start": userRule(2, "per-start"),
  "axis.cli-runs/1.stop": userRule(2),
  // DC-3a/DC-3c (terminals-contract.md section 1): moved from planned.ts unchanged; never a web client (WEB_ALLOWED) or a plugin
  // (the deny list); served only when the pty port and the trust-registry routing allow (the composition drops it otherwise).
  "axis.terminals/1.open": userRule(2, "per-start"),
  "axis.terminals/1.list": userRule(0),
  "axis.terminals/1.close": userRule(2),
  "axis.terminals/1.attach": userRule(2),
  "axis.cli-runs/1.get": userRule(0),
  "axis.cli-runs/1.list": userRule(0),
  "axis.providers/1.list": userRule(0),
  "axis.git/1.pushPlan": userRule(1),
  "axis.git/1.commit": userRule(2, "project"),
  "axis.git/1.push": userRule(4, "project"),
  "axis.git/1.compareUrl": userRule(0),
  "axis.review/1.diff": userRule(1),
  "axis.review/1.content": userRule(1),
  "axis.review/1.hunks": userRule(1),
  "axis.review/1.build": userRule(1),
  "axis.review/1.complete": userRule(2),
  "axis.runs/1.start": userRule(2, "project"),
  "axis.runs/1.cancel": userRule(2),
  "axis.runs/1.get": userRule(0),
  "axis.runs/1.list": userRule(0),
  "axis.runs/1.events": userRule(0),
  "axis.events/1.subscribe": userRule(0),
  "axis.events/1.unsubscribe": userRule(0),
  // axis.pages/1 (PV-Q1 slice 2, ADR 0010): the user's own connection only. Marking a version reviewed lowers taint and deleting
  // destroys versions: both tier 4, confirmed in main's native dialog (threat-model-phase2a O-4; tier 3 has no native step). Runs reach pages through their tools.
  "axis.pages/1.list": userRule(0),
  "axis.pages/1.get": userRule(0),
  "axis.pages/1.versions": userRule(0),
  "axis.pages/1.create": userRule(1),
  "axis.pages/1.update": userRule(1),
  "axis.pages/1.restore": userRule(1),
  "axis.pages/1.markReviewed": userRule(4),
  "axis.pages/1.delete": userRule(4),
  // axis.tasks/1 (PV-T1 slice 2a): the user's own connection only. Record writes are tier 1 (assigning starts nothing); delete is
  // destructive, tier 4: confirmed in main's native dialog. Runs reach tasks through their tools.
  "axis.tasks/1.list": userRule(0),
  "axis.tasks/1.get": userRule(0),
  "axis.tasks/1.revisions": userRule(0),
  "axis.tasks/1.create": userRule(1),
  "axis.tasks/1.update": userRule(1),
  "axis.tasks/1.setStatus": userRule(1),
  "axis.tasks/1.assign": userRule(1),
  "axis.tasks/1.link": userRule(1),
  "axis.tasks/1.unlink": userRule(1),
  "axis.tasks/1.delete": userRule(4),
  // Start (PV-T1 slice 2b): the preview is a read; the start runs a worker, so it is tier 4 (main's dialog names the task,
  // the worker and the trust of its text) and gated on the project's trust like any run start.
  "axis.tasks/1.startPreview": userRule(0),
  "axis.tasks/1.start": userRule(4, "project"),
  "axis.messages/1.send": userRule(2),
  "axis.messages/1.thread": userRule(1),
  "axis.messages/1.threads": userRule(0),
  "axis.messages/1.read": userRule(1),
  "axis.messages/1.markRead": userRule(1),
  "axis.messages/1.pause": userRule(2),
  "axis.messages/1.resume": userRule(2),
  "axis.messages/1.settings": userRule(0),
  "axis.messages/1.updateSettings": userRule(2),
  "axis.messages/1.enableCliEndpoint": userRule(4), // PV-M7 slice 2: tier 4, main's native confirmation
  "axis.messages/1.disableCliEndpoint": userRule(1), // a decrease, at once
  "axis.forge/1.pullRequests": userRule(0),
  "axis.forge/1.pinRepository": userRule(1),
  "axis.agents/1.list": userRule(0),
  "axis.agents/1.get": userRule(0),
  "axis.agents/1.create": userRule(2),
  "axis.agents/1.update": userRule(2),
  "axis.agents/1.archive": userRule(1),
  "axis.agents/1.restore": userRule(1),
  "axis.agents/1.start": userRule(2, "project"),
  "axis.agent-groups/1.list": userRule(0),
  "axis.agent-groups/1.create": userRule(1),
  "axis.agent-groups/1.rename": userRule(1),
  "axis.agent-groups/1.reorder": userRule(1),
  "axis.agent-groups/1.delete": userRule(1),
  "axis.agent-groups/1.assign": userRule(2),
  "axis.attention/1.summary": userRule(0),
  "axis.usage/1.summary": userRule(0),
  // axis.integrations/1, the PV-N1f read slice (net-read-slice.md §6): list and status reveal and send nothing; read reaches the
  // network with a credential, so it is gated on project trust. connect, disconnect and write stay planned.
  "axis.integrations/1.list": userRule(0),
  "axis.integrations/1.status": userRule(0),
  "axis.integrations/1.read": userRule(0, "project"),
});
