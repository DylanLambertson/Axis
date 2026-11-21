// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { z } from "zod";
import {
  MAX_HOP,
  MAX_SETTINGS_AGENTS,
  messagingSettingsSchema,
  principalKey,
  type MessagesRefusalCode,
  type Principal,
} from "@axis/protocol";

/**
 * Who may send to whom (docs/design/inter-agent-communication.md sections 4.1, 4.2, 7.3 and 10), as pure functions of
 * the attested caller, the directory and the project's settings. The message service runs them for every recipient
 * when it accepts a message, and `deliverable` runs them again before a delivery (slice 2): a setting changed in between
 * wins (review 2, NS1).
 */

/** The caller as the binding attested it (the bridge: the user only; the broker and the endpoint: PV-M4, PV-M6). Never a payload. */
export type MessageCaller =
  | { readonly kind: "user" }
  | {
      readonly kind: "agent";
      readonly agentId: string;
      readonly runId: string | null;
      /** False exactly for a CLI endpoint sender (docs/design/inter-agent-cli-endpoint.md section 4). */
      readonly verified: boolean;
      /** The highest hop the sending run has received through any taint source (section 7.3), from the daemon's run state. */
      readonly receivedHop: number;
    }
  | { readonly kind: "plugin"; readonly pluginId: string; readonly receivedHop: number };

export const callerKey = (c: MessageCaller): string => principalKey(callerPrincipal(c));
export function callerPrincipal(c: MessageCaller): Principal {
  return c.kind === "user" ? { kind: "user" } : c.kind === "agent" ? { kind: "agent", agentId: c.agentId } : { kind: "plugin", pluginId: c.pluginId };
}

export interface AgentEntry {
  readonly agentId: string;
  readonly projectId: string;
  /** Null for an agent in no group: it shares a group with nobody. */
  readonly groupId: string | null;
  readonly kind: "composer" | "cli";
}
export interface GroupEntry {
  readonly groupId: string;
  readonly projectId: string;
  /** Agent ids, bounded by the directory. */
  readonly members: readonly string[];
}
/**
 * Agents, groups and projects as the daemon holds them. Agents and groups are PV-G3's records; until it lands the host
 * passes a directory with projects only (`journalDirectory`), so no agent can be addressed and every agent recipient is
 * `recipient_refused`.
 */
export interface MessagingDirectory {
  project(projectId: string): boolean;
  agent(agentId: string): AgentEntry | undefined;
  group(groupId: string): GroupEntry | undefined;
  /** The project's agents, at most `MAX_SETTINGS_AGENTS`. */
  agents(projectId: string): readonly AgentEntry[];
}

export function journalDirectory(projects: { getProject(id: string): unknown }): MessagingDirectory {
  return {
    project: (id) => projects.getProject(id) !== undefined,
    agent: () => undefined,
    group: () => undefined,
    agents: () => [],
  };
}

/** A project's stored settings: `messagingSettingsSchema` without the project id and the agents (held per agent). */
export const projectSettingsSchema = messagingSettingsSchema.omit({ projectId: true, agents: true });
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = Object.freeze({
  crossGroup: false,
  crossGroupPairs: [],
  secretScan: "refuse",
  retentionDays: 30,
  paused: { project: false, groups: [], agents: [] },
});
export interface AgentSettings {
  readonly acceptsFrom: "none" | "group" | "project";
  readonly cliMessaging: boolean;
  readonly muted: boolean;
}
/** Section 4.1: `group` by default; a CLI agent starts at `none` (docs/design/inter-agent-cli-endpoint.md section 6). */
export const defaultAgentSettings = (a: AgentEntry): AgentSettings => ({ acceptsFrom: a.kind === "cli" ? "none" : "group", cliMessaging: false, muted: false });

export interface PolicyContext {
  readonly projectId: string;
  readonly settings: ProjectSettings;
  readonly directory: MessagingDirectory;
  readonly agentSettings: (a: AgentEntry) => AgentSettings;
}

export class MessageRefusal extends Error {
  constructor(
    readonly code: MessagesRefusalCode,
    readonly reason: string,
  ) {
    super("message request refused");
    this.name = "MessageRefusal";
  }
}
export const refuse = (code: MessagesRefusalCode, reason: string): never => {
  throw new MessageRefusal(code, reason);
};
export const NOT_FOUND = (): never => refuse("E_NOT_FOUND", "not_found");
const RECIPIENT_REFUSED = (): never => refuse("E_CONFLICT", "recipient_refused");

/** The sender's own agent record, in this project; undefined for the user and a plugin. Unknown or elsewhere: refused. */
export function senderEntry(caller: MessageCaller, ctx: PolicyContext): AgentEntry | undefined {
  if (caller.kind !== "agent") return undefined;
  const entry = ctx.directory.agent(caller.agentId);
  if (entry === undefined || entry.projectId !== ctx.projectId) return RECIPIENT_REFUSED();
  return entry;
}

/** Section 10: a paused project, group or agent sends nothing; the user is never paused. */
export function senderPaused(caller: MessageCaller, entry: AgentEntry | undefined, s: ProjectSettings): boolean {
  if (caller.kind === "user") return false;
  if (s.paused.project) return true;
  if (entry === undefined) return false;
  return s.paused.agents.includes(entry.agentId) || (entry.groupId !== null && s.paused.groups.includes(entry.groupId));
}
/** Section 10: nothing is delivered into a paused scope (the message stays queued). */
export function recipientPaused(target: Principal, ctx: PolicyContext): boolean {
  if (target.kind !== "agent") return ctx.settings.paused.project;
  const e = ctx.directory.agent(target.agentId);
  return ctx.settings.paused.project || ctx.settings.paused.agents.includes(target.agentId) || (e?.groupId != null && ctx.settings.paused.groups.includes(e.groupId));
}

const pairAllowed = (s: ProjectSettings, a: string | null, b: string | null): boolean =>
  a !== null && b !== null && s.crossGroupPairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

/**
 * Null when `caller` may address `target` in the context's project (section 4.1), else the refusal reason. The user may
 * address any agent of the project; an agent the user and agents its group and its own settings allow; a plugin only the
 * user. Nobody addresses itself. An agent of another project is `recipient_refused` to an agent and `cross_project` to
 * the user (who can see every project); an unknown one is `recipient_refused` to both (no existence oracle).
 */
export function mayAddress(caller: MessageCaller, sender: AgentEntry | undefined, target: Principal, ctx: PolicyContext): string | null {
  if (target.kind === "user") return caller.kind === "user" ? "recipient_refused" : null;
  if (target.kind !== "agent") return "recipient_refused";
  const to = ctx.directory.agent(target.agentId);
  if (to === undefined) return "recipient_refused";
  if (to.projectId !== ctx.projectId) return caller.kind === "user" ? "cross_project" : "recipient_refused";
  if (caller.kind === "user") return null;
  if (caller.kind !== "agent" || sender === undefined || sender.agentId === to.agentId) return "recipient_refused";
  const sameGroup = sender.groupId !== null && sender.groupId === to.groupId;
  if (!sameGroup && !ctx.settings.crossGroup && !pairAllowed(ctx.settings, sender.groupId, to.groupId)) return "recipient_refused";
  const accepts = ctx.agentSettings(to).acceptsFrom;
  if (accepts === "none" || (accepts === "group" && !sameGroup)) return "recipient_refused";
  return null;
}

/** A recipient as named in `send`. */
export type NamedRecipient = { readonly agent: string } | { readonly group: string } | { readonly user: true };

/**
 * Expand groups (at accept time; the expansion is recorded), check every principal against `mayAddress` and return them
 * unique, in order. Any refused principal refuses the whole send (no partial sends, and the reason does not say which).
 */
export function expandRecipients(caller: MessageCaller, sender: AgentEntry | undefined, named: readonly NamedRecipient[], ctx: PolicyContext, max: number): Principal[] {
  const out = new Map<string, Principal>();
  const self = callerKey(caller);
  for (const r of named) {
    let ps: Principal[];
    if ("user" in r) ps = [{ kind: "user" }];
    else if ("agent" in r) ps = [{ kind: "agent", agentId: r.agent }];
    else {
      const g = ctx.directory.group(r.group);
      if (g === undefined) return RECIPIENT_REFUSED();
      if (g.projectId !== ctx.projectId) return refuse("E_CONFLICT", caller.kind === "user" ? "cross_project" : "recipient_refused");
      ps = g.members.filter((id) => `agent:${id}` !== self).map((agentId) => ({ kind: "agent", agentId }));
      if (ps.length === 0) return RECIPIENT_REFUSED();
    }
    for (const p of ps) {
      const reason = mayAddress(caller, sender, p, ctx);
      if (reason !== null) return refuse("E_CONFLICT", reason);
      out.set(principalKey(p), p);
      if (out.size > max) return refuse("E_INVALID_ARGUMENT", "too_many_recipients");
    }
  }
  return [...out.values()];
}

/**
 * The project of a new thread (section 2; messages-contract.md section 7): the sender's own for an agent, and otherwise
 * the one project every named agent and group belongs to. A send to the user alone from the user, or recipients that
 * span projects, is refused. A plugin cannot open a thread (section 4.1: only threads the user added it to).
 */
export function newThreadProject(caller: MessageCaller, named: readonly NamedRecipient[], directory: MessagingDirectory): string {
  if (caller.kind === "plugin") return RECIPIENT_REFUSED();
  if (caller.kind === "agent") {
    const entry = directory.agent(caller.agentId);
    return entry === undefined ? RECIPIENT_REFUSED() : entry.projectId;
  }
  const projects = new Set<string>();
  for (const r of named) {
    if ("user" in r) continue;
    const p = "agent" in r ? directory.agent(r.agent)?.projectId : directory.group(r.group)?.projectId;
    if (p === undefined) return RECIPIENT_REFUSED();
    projects.add(p);
  }
  if (projects.size === 0) return RECIPIENT_REFUSED();
  if (projects.size > 1) return refuse("E_CONFLICT", "cross_project");
  return [...projects][0] as string;
}

/** Section 7.3: 0 for the user; otherwise one past the highest hop the run received and the hop of what it replies to. */
export function hopOf(caller: MessageCaller, replyHop: number | undefined): number {
  if (caller.kind === "user") return 0;
  const received = caller.receivedHop;
  if (!Number.isSafeInteger(received) || received < 0 || received > MAX_HOP) return refuse("E_CONFLICT", "hop_limit");
  const hop = Math.max(received, replyHop ?? 0) + 1;
  return hop > MAX_HOP ? refuse("E_CONFLICT", "hop_limit") : hop;
}

/** Agents of the project with their settings, as `settings` answers them (bounded). */
export function agentRows(directory: MessagingDirectory, projectId: string, settingsOf: (a: AgentEntry) => AgentSettings) {
  return directory
    .agents(projectId)
    .slice(0, MAX_SETTINGS_AGENTS)
    .filter((a) => a.projectId === projectId)
    .map((a) => ({ agentId: a.agentId, kind: a.kind, ...settingsOf(a) }));
}
