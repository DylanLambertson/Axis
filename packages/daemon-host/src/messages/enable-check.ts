// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Journal } from "@axis/journal";
import { resolveCliAgentsSetting } from "@axis/pty-policy";
import { MESSAGE_AUDIT } from "./audit.js";
import { decideCliMessaging, type EnableDecision } from "./enable-rule.js";

/**
 * The host's facts for the CLI messaging enable rule (PV-M7 slice 1): the worker's `axis.cliAgents` entry as main returns it
 * (user, application or machine scope only, the same path as a CLI start), its home workspace, and which CLI
 * project-configuration files exist there (`lstat`: a link counts as present). Any gap refuses: an unknown worker, a
 * composer worker, no live home, no answer from main, an entry that is not there (`no_entry` / `no_workspace`).
 */
export interface EnableCheckDeps {
  readonly journal: { readonly agents: Pick<Journal["agents"], "get">; readonly getWorkspace: Journal["getWorkspace"] };
  readonly settingsGet: (key: "axis.cliAgents", o: { readonly signal: AbortSignal }) => Promise<unknown>;
  readonly platform?: NodeJS.Platform;
  /** Whether an absolute path exists; `lstat` by default. */
  readonly exists?: (path: string) => boolean;
}

const present = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** The real path of an absolute executable (a link to a versioned binary), or undefined. */
export const realOf = (exe: string): string | undefined => {
  if (!isAbsolute(exe)) return undefined;
  try {
    return realpathSync(exe);
  } catch {
    return undefined;
  }
};

/** The launch entry of a CLI worker as main has it now, and its home's worktree path; undefined for any gap. */
export async function cliWorkerLaunch(deps: EnableCheckDeps, agentId: string, signal: AbortSignal): Promise<{ readonly argv: readonly string[]; readonly bypassesPrompts: boolean; readonly root: string } | undefined> {
  const worker = deps.journal.agents.get(agentId);
  if (worker === undefined || worker.archived || worker.launch.kind !== "cli") return undefined;
  const root = deps.journal.getWorkspace(worker.homeWorkspaceId)?.worktreePath;
  if (root === undefined || root === null || root === "") return undefined;
  let value: unknown;
  try {
    value = await deps.settingsGet("axis.cliAgents", { signal });
  } catch {
    return undefined;
  }
  const entryId = worker.launch.entryId;
  const entry = resolveCliAgentsSetting({ user: value }, { platform: deps.platform ?? process.platform }).agents.find((a) => a.id === entryId);
  if (entry === undefined) return undefined;
  return { argv: [...entry.command, ...entry.args], bypassesPrompts: entry.bypassesPrompts === true, root };
}

/** The enable rule's decision for a worker, from the host's facts. */
export function hostEnableCheck(deps: EnableCheckDeps): (agentId: string, signal: AbortSignal) => Promise<EnableDecision> {
  const exists = deps.exists ?? present;
  return async (agentId, signal) => {
    const launch = await cliWorkerLaunch(deps, agentId, signal);
    if (launch === undefined) return { allowed: false, rule: "no_entry" };
    const real = realOf(launch.argv[0] ?? "");
    return decideCliMessaging({ argv: launch.argv, ...(real === undefined ? {} : { executableReal: real }), bypassesPrompts: launch.bypassesPrompts, exists: (segments) => exists(join(launch.root, ...segments)) });
  };
}

/**
 * The re-check at mint (master decision 4): a worker's CLI run gets its endpoint only if the rule still allows it over the
 * argv that actually runs (the spawn spec's) and the entry's marking read again now. Refused (or no answer within 2 s: well
 * inside the supervisor's 10 s start bound), the run starts without an endpoint and `mint_refused` is audited with the rule.
 * A run of no worker passes: the mint refuses it anyway.
 */
export function hostMintRecheck(deps: EnableCheckDeps & { readonly agentOfRun: (runId: string) => string | undefined; readonly acknowledged: (agentId: string) => readonly string[]; readonly audit: { append(e: { actor: "daemon"; action: string; target: string; outcome: "denied"; payload: Record<string, unknown> }): unknown }; readonly noteWrite?: () => void }): (spec: { readonly runId: string; readonly argv: readonly string[] }) => Promise<boolean> {
  const exists = deps.exists ?? present;
  return async (spec) => {
    const worker = deps.agentOfRun(spec.runId);
    if (worker === undefined) return true;
    const launch = await cliWorkerLaunch(deps, worker, AbortSignal.timeout(2_000));
    const decision = launch === undefined ? { allowed: false as const, rule: "no_entry" } : decideCliMessaging({ argv: spec.argv, ...((r) => (r === undefined ? {} : { executableReal: r }))(realOf(spec.argv[0] ?? "")), bypassesPrompts: launch.bypassesPrompts, exists: (segments) => exists(join(launch.root, ...segments)) });
    // A project-configuration file present now that the user did not acknowledge at enable (it appeared since): messaging
    // is suspended for this run until the user confirms again (endpoint design section 6; review 1 SF3).
    const acked = decision.allowed ? deps.acknowledged(worker) : [];
    const unacked = decision.allowed ? decision.warnings.filter((w) => !acked.includes(w.path)).length : 0;
    if (decision.allowed && unacked === 0) return true;
    const rule = decision.allowed ? "repo_config_unacknowledged" : decision.rule;
    deps.audit.append({ actor: "daemon", action: MESSAGE_AUDIT.endpoint, target: `run:${spec.runId}`, outcome: "denied", payload: { runId: spec.runId, agentId: worker, event: "mint_refused", rule, ...(unacked === 0 ? {} : { warnings: unacked }) } });
    deps.noteWrite?.();
    return false;
  };
}
