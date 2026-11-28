// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { PluginPermission } from "@axis/journal";
import { RULES } from "./rules.js";
import type { Rule } from "./rule-types.js";

/**
 * What a plugin may call (ADR 0008 decisions 4 and 6, ticket PV-K1b): an ALLOW-LIST of closed method sets, one per permission,
 * over served methods only. A permission whose operations are not served yet (tasks) has an empty set; a later contract adds
 * its methods here, at most the operations decision 6 names. A plugin call is allowed only when its method is in the set of a
 * permission granted to the plugin in the project and the plugin is enabled there (`RuleTablePolicy`).
 *
 * The deny list is a SECOND fence, checked at startup (`checkPluginCoverage`, which fails closed) and again per call: no plugin
 * set may ever hold one of these methods, or any method whose tier is 4 or more. Tier 4 is where native confirmation lives, so a
 * plugin can never cause a native dialog in 4a; PV-K2 would have to design one first.
 */

export const PLUGIN_METHOD_SETS: Readonly<Record<PluginPermission, readonly string[]>> = Object.freeze({
  "agents.read": Object.freeze(["axis.agents/1.list", "axis.agents/1.get", "axis.agent-groups/1.list", "axis.runs/1.list", "axis.runs/1.get", "axis.cli-runs/1.list", "axis.cli-runs/1.get"]),
  "messages.send": Object.freeze(["axis.messages/1.send", "axis.messages/1.threads", "axis.messages/1.thread", "axis.messages/1.read", "axis.messages/1.markRead"]),
  "tasks.read": Object.freeze([]),
  "tasks.write": Object.freeze([]),
  "pages.read": Object.freeze(["axis.pages/1.list", "axis.pages/1.get", "axis.pages/1.versions"]),
  "pages.write": Object.freeze(["axis.pages/1.create", "axis.pages/1.update"]),
  "runs.start": Object.freeze(["axis.runs/1.start"]),
  "files.read": Object.freeze(["axis.review/1.content", "axis.review/1.diff"]),
});

/**
 * Tiers a plugin call is raised to (never lowered), from ADR 0008 decision 6's table: a page write is tier 2 (the user row is 1),
 * a plugin-started composer run a tier-3 user challenge. Every other set method's row already has the ADR's tier (a test
 * compares each one with the ADR table).
 */
export const PLUGIN_SET_TIER: Readonly<Record<string, number>> = Object.freeze({ "axis.pages/1.create": 2, "axis.pages/1.update": 2, "axis.runs/1.start": 3 });

/** Whole contracts no plugin may reach. */
export const PLUGIN_DENY_CONTRACTS: readonly string[] = Object.freeze(["axis.approvals/", "axis.plugins/", "axis.audit/", "axis.providers/", "axis.projects/", "axis.worktrees/", "axis.git/", "axis.forge/", "axis.events/", "axis.integrations/", "axis.usage/", "axis.attention/", "axis.terminals/"]);

/** Methods no plugin may reach, whatever is granted (ADR 0008 decision 4's deny list and decision 6's exclusions). */
export const PLUGIN_DENY_METHODS: ReadonlySet<string> = new Set([
  "axis.cli-runs/1.start",
  "axis.cli-runs/1.stop",
  "axis.runs/1.cancel",
  "axis.runs/1.events",
  "axis.review/1.complete",
  "axis.messages/1.pause",
  "axis.messages/1.resume",
  "axis.messages/1.settings",
  "axis.messages/1.updateSettings",
  "axis.agents/1.create",
  "axis.agents/1.update",
  "axis.agents/1.archive",
  "axis.agents/1.restore",
  "axis.agents/1.start",
  "axis.agent-groups/1.create",
  "axis.agent-groups/1.rename",
  "axis.agent-groups/1.reorder",
  "axis.agent-groups/1.delete",
  "axis.agent-groups/1.assign",
  "axis.pages/1.restore",
  "axis.pages/1.markReviewed",
  "axis.pages/1.delete",
  // Task Start, its preview, an assignment that starts work, and delete are the user's alone (ADR 0008 decision 6, TSK-1).
  "axis.tasks/1.start",
  "axis.tasks/1.startPreview",
  "axis.tasks/1.assign",
  "axis.tasks/1.delete",
  // Not decided for plugins yet (ADR 0008 decides only list and get for tasks.read and draft create and update for tasks.write):
  // denied until a decision names them (review of the audit-A fix, N3).
  "axis.tasks/1.revisions",
  "axis.tasks/1.setStatus",
  "axis.tasks/1.link",
  "axis.tasks/1.unlink",
  // The CLI endpoint switch (PV-M7 slice 2): the user's alone. The disable too, so a plugin cannot switch the user's endpoints off.
  "axis.messages/1.enableCliEndpoint",
  "axis.messages/1.disableCliEndpoint",
]);

/** The highest tier a plugin call may have after every raise; 4 and above need native confirmation. */
export const PLUGIN_MAX_TIER = 3;

export const pluginDenied = (key: string): boolean => PLUGIN_DENY_METHODS.has(key) || PLUGIN_DENY_CONTRACTS.some((c) => key.startsWith(c));

/**
 * Dangerous combinations (review N7, ADR 0008 decision 6 and ADR 0009's amendment): DATA for PV-K2's install and update dialogs,
 * no logic here. Any `reads` grant (or the contribution) together with `with` reads as the sentence.
 */
export const PLUGIN_DANGEROUS_COMBINATIONS = Object.freeze([
  Object.freeze({ reads: Object.freeze(["files.read", "agents.read", "pages.read", "tasks.read", "contribution:messageParticipant"]), with: "net:<origin>", text: "can send your code or project data to <origin>" }),
  Object.freeze({ reads: Object.freeze(["integration:<id>"]), with: "net:<origin>", text: "can send data from <integration> to <origin>" }),
]);

/** Every way the plugin sets disagree with the served table or the deny list. Empty means sound. */
export function pluginCoverageProblems(rules: Readonly<Record<string, Rule>> = RULES, sets: Readonly<Record<string, readonly string[]>> = PLUGIN_METHOD_SETS): string[] {
  const out: string[] = [];
  for (const [permission, keys] of Object.entries(sets)) {
    for (const key of keys) {
      const rule = rules[key];
      if (rule === undefined) out.push(`${key} (${permission}): in a plugin set but not served`);
      if (pluginDenied(key)) out.push(`${key} (${permission}): on the plugin deny list`);
      if (Math.max(rule?.tier ?? 0, PLUGIN_SET_TIER[key] ?? 0) > PLUGIN_MAX_TIER) out.push(`${key} (${permission}): tier 4 or more`);
    }
  }
  return out.sort();
}

/** Throws (startup fails closed) when a plugin set names an unserved, denied or tier-4 method. */
export function checkPluginCoverage(rules: Readonly<Record<string, Rule>> = RULES, sets?: Readonly<Record<string, readonly string[]>>): void {
  const problems = pluginCoverageProblems(rules, sets);
  if (problems.length > 0) throw new Error(`plugin policy coverage: ${problems.join("; ")}`);
}
