// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { MessageRecords } from "@axis/journal";
import { MAX_SETTINGS_AGENTS, type MessagesRequest, type MessagesResponse } from "@axis/protocol";
import { MESSAGE_AUDIT, type MessageAuditSink } from "./audit.js";
import type { EnableDecision, EnableWarning } from "./enable-rule.js";
import { checked } from "./wire.js";
import { NOT_FOUND, agentRows, defaultAgentSettings, refuse, type AgentSettings, type MessageCaller, type MessagingDirectory, type PolicyContext, type ProjectSettings } from "./policy.js";

/**
 * Messaging settings and the kill switch (docs/design/inter-agent-communication.md sections 4.1 and 10): user-only tier 2
 * writes, held by the daemon (never repository settings, CFG-1). Each change is one setting with one audit row naming its
 * before and after (`message.settings`), or a `message.pause` / `message.resume` row; the row commits with the change.
 * A project, group or agent the directory does not know is `not_found`.
 *
 * Enabling a CLI worker's endpoint (`cliMessaging: true`) needs the enable rule's decision (PV-M7 slice 1, `enable-rule.ts`),
 * which the handler makes first: without one, or refused, it is `bypass_entry`, audited by the rule's id.
 */

/** A committed change the CLI endpoints act on (PV-M6 slice 3). */
export type MessagingSettingsEvent = { readonly kind: "cliMessagingOff"; readonly agentId: string } | { readonly kind: "paused"; readonly projectId: string };

/** Enable refusals the caller sees by name: the launch could not be judged (the rest are `bypass_entry`). */
const JUDGED: ReadonlySet<string> = new Set(["wrapper_unparsed", "config_unparsed", "too_many_repo_files", "empty_argv", "unknown_flag", "env_assignment", "config_home", "real_path_unresolved"]);

export interface MessagingSettingsDeps {
  /** Called after the change committed; a throw is audited (`hook_failed`) and never fails the user's write. */
  readonly onChange?: (e: MessagingSettingsEvent) => void;
  readonly store: MessageRecords;
  readonly directory: MessagingDirectory;
  readonly audit: MessageAuditSink;
  readonly noteWrite?: () => void;
  readonly context: (projectId: string) => PolicyContext;
}

export interface MessagingSettingsService {
  /** The project's settings; the handler adds the global CLI endpoint switch beside them. */
  settings(caller: MessageCaller, req: MessagesRequest<"settings">): Omit<MessagesResponse<"settings">, "cliEndpoint">;
  /**
   * `enable`: the enable rule's decision for `cliMessaging: true` (PV-M7 slice 1), made by the handler before this
   * synchronous write. Without one, enabling is refused (`bypass_entry`): it fails closed.
   */
  updateSettings(caller: MessageCaller, req: MessagesRequest<"updateSettings">, enable?: EnableDecision): MessagesResponse<"updateSettings">;
  pause(caller: MessageCaller, req: MessagesRequest<"pause">): MessagesResponse<"pause">;
  resume(caller: MessageCaller, req: MessagesRequest<"resume">): MessagesResponse<"resume">;
}

type Scope = MessagesRequest<"pause">["scope"];
type Scalar = string | number | boolean;

export function createMessagingSettings(deps: MessagingSettingsDeps): MessagingSettingsService {
  const { store, directory } = deps;
  const userOnly = (c: MessageCaller): void => void (c.kind === "user" || NOT_FOUND());
  const audit = (action: string, target: string, payload: Record<string, unknown>): void => {
    deps.audit.append({ actor: "user", action, target, outcome: "success", payload });
    deps.noteWrite?.();
  };
  const project = (id: string): PolicyContext => (directory.project(id) ? deps.context(id) : NOT_FOUND());
  const agentSettingsOf = (agentId: string): { projectId: string; current: AgentSettings } => {
    const a = directory.agent(agentId);
    if (a === undefined || !directory.project(a.projectId)) return NOT_FOUND();
    return { projectId: a.projectId, current: store.agentSettings(agentId) ?? defaultAgentSettings(a) };
  };
  const notify = (e: MessagingSettingsEvent): void => {
    try {
      deps.onChange?.(e);
    } catch {
      const target = e.kind === "paused" ? `project:${e.projectId}` : `agent:${e.agentId}`;
      try {
        deps.audit.append({ actor: "daemon", action: MESSAGE_AUDIT.endpoint, target, outcome: "error", payload: { event: "hook_failed", ...(e.kind === "paused" ? { projectId: e.projectId } : { agentId: e.agentId }) } });
        deps.noteWrite?.();
      } catch {
        // The write has committed: a failing audit sink must not turn it into an error for the user (review s3 N2).
      }
    }
  };
  const view = (ctx: PolicyContext) => ({ projectId: ctx.projectId, ...ctx.settings, agents: agentRows(directory, ctx.projectId, ctx.agentSettings) });

  function setProject(ctx: PolicyContext, next: ProjectSettings, setting: string, before: Scalar, after: Scalar, groups?: string): boolean {
    const changed = before !== after;
    if (changed) {
      store.setSettings(ctx.projectId, next);
      audit(MESSAGE_AUDIT.settings, `project:${ctx.projectId}`, { projectId: ctx.projectId, setting, before, after, ...(groups === undefined ? {} : { groups }) });
    }
    return changed;
  }

  function scopeProject(scope: Scope): { projectId: string; kind: "project" | "group" | "agent"; id: string } {
    if ("project" in scope) return directory.project(scope.project) ? { projectId: scope.project, kind: "project", id: scope.project } : NOT_FOUND();
    if ("group" in scope) {
      const g = directory.group(scope.group);
      return g !== undefined && directory.project(g.projectId) ? { projectId: g.projectId, kind: "group", id: g.groupId } : NOT_FOUND();
    }
    const a = directory.agent(scope.agent);
    return a !== undefined && directory.project(a.projectId) ? { projectId: a.projectId, kind: "agent", id: a.agentId } : NOT_FOUND();
  }

  function setPaused(scope: Scope, paused: boolean): boolean {
    const target = scopeProject(scope);
    const changed = store.transact(() => {
      const s = deps.context(target.projectId).settings;
      const p = s.paused;
      const list = target.kind === "group" ? p.groups : target.kind === "agent" ? p.agents : undefined;
      const was = list === undefined ? p.project : list.includes(target.id);
      if (was !== paused) {
        if (list !== undefined && paused && list.length >= MAX_SETTINGS_AGENTS) refuse("E_INVALID_ARGUMENT", "too_large");
        const nextList = list === undefined ? undefined : paused ? [...list, target.id] : list.filter((x) => x !== target.id);
        const next = { ...p, ...(list === undefined ? { project: paused } : target.kind === "group" ? { groups: nextList } : { agents: nextList }) };
        store.setSettings(target.projectId, { ...s, paused: next });
      }
      audit(paused ? MESSAGE_AUDIT.pause : MESSAGE_AUDIT.resume, `${target.kind}:${target.id}`, { scopeKind: target.kind, scopeId: target.id, changed: was !== paused });
      return was !== paused;
    });
    if (changed && paused) notify({ kind: "paused", projectId: target.projectId });
    return changed;
  }

  return {
    settings(caller, raw) {
      userOnly(caller);
      const req = checked("settings", raw);
      return { settings: view(project(req.projectId)) };
    },

    updateSettings(caller, raw, enable) {
      userOnly(caller);
      const req = checked("updateSettings", raw);
      let warnings: readonly EnableWarning[] = [];
      if (req.setting === "cliMessaging" && req.value && agentSettingsOf(req.agentId).current.cliMessaging !== true) {
        // The enable rule (PV-M7 slice 1), decided before the write so a refusal's audit row is not rolled back with it: no
        // decision, or a refusal, refuses with `bypass_entry`, audited by the rule's id only (never an argument).
        const rule = enable === undefined ? "no_check" : enable.allowed ? undefined : enable.rule;
        if (rule !== undefined) {
          deps.audit.append({ actor: "user", action: MESSAGE_AUDIT.endpoint, target: `agent:${req.agentId}`, outcome: "denied", payload: { agentId: req.agentId, event: "enable_refused", rule } });
          deps.noteWrite?.();
          // A launch the rule cannot judge says so (review 3 N15); every bypass the rule recognised is `bypass_entry`.
          refuse("E_CONFLICT", JUDGED.has(rule) ? rule : "bypass_entry");
        }
        warnings = enable !== undefined && enable.allowed ? enable.warnings : [];
        // The second step (review 1 SF4, M-3): with warnings, nothing is written until the request names every file warned
        // about; the first answer is the warnings alone. The confirmation is the shell's, resolved in the renderer (tier 2).
        const ack = req.acknowledged ?? [];
        if (!warnings.every((w) => ack.some((a) => a.path === w.path && a.cli === w.cli))) {
          deps.audit.append({ actor: "user", action: MESSAGE_AUDIT.endpoint, target: `agent:${req.agentId}`, outcome: "success", payload: { agentId: req.agentId, event: "enable_needs_confirmation", warnings: warnings.length } });
          deps.noteWrite?.();
          return { settings: view(deps.context(agentSettingsOf(req.agentId).projectId)), changed: false, warnings: [...warnings] };
        }
      }
      let off: string | undefined;
      const result = store.transact(() => {
        if (req.setting === "acceptsFrom" || req.setting === "cliMessaging" || req.setting === "muted") {
          const { projectId, current } = agentSettingsOf(req.agentId);
          if (req.setting === "cliMessaging" && req.value && current.cliMessaging !== true) {
            // Allowed (checked above): the row commits with the change.
            deps.audit.append({ actor: "user", action: MESSAGE_AUDIT.endpoint, target: `agent:${req.agentId}`, outcome: "success", payload: { agentId: req.agentId, event: "enable_allowed", warnings: warnings.length } });
          }
          const next: AgentSettings = { ...current, [req.setting]: req.value };
          const before = current[req.setting];
          const changed = before !== req.value;
          if (changed) {
            store.setAgentSettings(req.agentId, next);
            // The files acknowledged are what every mint compares against (review 1 SF3); off clears them.
            if (req.setting === "cliMessaging") store.setCliAcknowledged(req.agentId, req.value ? warnings.map((w) => w.path) : []);
            audit(MESSAGE_AUDIT.settings, `agent:${req.agentId}`, { projectId, agentId: req.agentId, setting: req.setting, before, after: req.value });
            if (req.setting === "cliMessaging" && before === true && req.value === false) off = req.agentId;
          }
          return { settings: view(deps.context(projectId)), changed, ...(warnings.length === 0 ? {} : { warnings: [...warnings] }) };
        }
        const ctx = project(req.projectId);
        const s = ctx.settings;
        let changed: boolean;
        if (req.setting === "crossGroupPair") {
          const [a, b] = req.groups;
          for (const g of [a, b]) if (directory.group(g)?.projectId !== ctx.projectId) NOT_FOUND();
          const has = s.crossGroupPairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
          const pairs = req.value ? (has ? s.crossGroupPairs : [...s.crossGroupPairs, [a, b] as [string, string]]) : s.crossGroupPairs.filter(([x, y]) => !((x === a && y === b) || (x === b && y === a)));
          if (pairs.length > 64) refuse("E_INVALID_ARGUMENT", "too_large");
          changed = setProject(ctx, { ...s, crossGroupPairs: pairs }, "crossGroupPair", has, req.value, `${a},${b}`);
        } else {
          changed = setProject(ctx, { ...s, [req.setting]: req.value }, req.setting, s[req.setting], req.value);
        }
        return { settings: view(deps.context(ctx.projectId)), changed };
      });
      if (off !== undefined) notify({ kind: "cliMessagingOff", agentId: off });
      return result;
    },

    pause(caller, raw) {
      userOnly(caller);
      const req = checked("pause", raw);
      return { scope: req.scope, paused: true, changed: setPaused(req.scope, true) };
    },

    resume(caller, raw) {
      userOnly(caller);
      const req = checked("resume", raw);
      return { scope: req.scope, paused: false, changed: setPaused(req.scope, false) };
    },
  };
}
