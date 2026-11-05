// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Setting scopes (threat model CFG-1, decision Q-3). axis.cliAgents, axis.terminals.scrubEnvironment,
// axis.git.runHooks and axis.worktrees.root are read only from the default, user, application and machine
// scopes (precedence: machine, application, user, default). Values from a repository (workspace or folder
// scope), and from any scope name not listed, are ignored with a warning. The caller maps its own scope names
// onto these; for example a remote window's user setting must be passed as `user` or `machine`, or it is dropped.
import { cliAgentSchema, type CliAgent } from "./agent.js";
import { checkExecutable } from "./exec.js";
import { hasDotDot, isPlainAbsolute } from "./paths.js";

/** Scopes whose values are trusted, lowest precedence first. */
export const TRUSTED_SCOPES = ["default", "user", "application", "machine"] as const;
const IGNORED_SCOPES = ["workspace", "workspaceFolder", "folder"] as const;

export type ValuesByScope = Readonly<Partial<Record<string, unknown>>>;
export interface SettingWarning {
  readonly setting: string;
  readonly scope: string;
  readonly message: string;
}

function own(o: ValuesByScope, k: string): unknown {
  return Object.hasOwn(o, k) ? o[k] : undefined;
}

function ignoredScopeWarnings(setting: string, v: ValuesByScope): SettingWarning[] {
  const out: SettingWarning[] = [];
  for (const scope of Object.keys(v)) {
    if ((TRUSTED_SCOPES as readonly string[]).includes(scope) || v[scope] === undefined) continue;
    const known = (IGNORED_SCOPES as readonly string[]).includes(scope);
    out.push({
      setting,
      scope,
      message: known
        ? `Ignored ${setting} from ${scope} settings: it is only read from the default, user, application or machine scope; workspace and folder scopes are ignored.`
        : `Ignored ${setting} from unknown scope '${scope}'.`,
    });
  }
  return out;
}

/** The highest-precedence trusted scope that defines the setting, or undefined. */
function pick(v: ValuesByScope): { scope: string; value: unknown } | undefined {
  for (let i = TRUSTED_SCOPES.length - 1; i >= 0; i--) {
    const scope = TRUSTED_SCOPES[i] as string;
    const value = own(v, scope);
    if (value !== undefined) return { scope, value };
  }
  return undefined;
}

export interface CliAgentsResult {
  readonly agents: readonly CliAgent[];
  readonly warnings: readonly SettingWarning[];
}

/** Resolves axis.cliAgents. Invalid entries are dropped one by one with a warning (fail closed). */
export function resolveCliAgentsSetting(valuesByScope: ValuesByScope, opts: { readonly platform?: NodeJS.Platform } = {}): CliAgentsResult {
  const platform = opts.platform ?? process.platform;
  const setting = "axis.cliAgents";
  const warnings = ignoredScopeWarnings(setting, valuesByScope);
  const chosen = pick(valuesByScope);
  if (!chosen) return { agents: [], warnings };
  if (!Array.isArray(chosen.value)) {
    warnings.push({ setting, scope: chosen.scope, message: `${setting} must be an array; ignored.` });
    return { agents: [], warnings };
  }
  const agents: CliAgent[] = [];
  const ids = new Set<string>();
  chosen.value.forEach((entry: unknown, i: number) => {
    const r = cliAgentSchema.safeParse(entry);
    if (!r.success) {
      warnings.push({ setting, scope: chosen.scope, message: `Dropped ${setting}[${i}]: ${r.error.issues[0]?.message ?? "invalid"}.` });
    } else if (checkExecutable(r.data.command[0] as string, platform) !== undefined) {
      warnings.push({ setting, scope: chosen.scope, message: `Dropped ${setting}[${i}]: ${checkExecutable(r.data.command[0] as string, platform) as string}.` });
    } else if (ids.has(r.data.id)) {
      warnings.push({ setting, scope: chosen.scope, message: `Dropped ${setting}[${i}]: duplicate id '${r.data.id}'.` });
    } else {
      ids.add(r.data.id);
      agents.push(r.data);
    }
  });
  return { agents, warnings };
}

export interface SecuritySettings {
  readonly scrubEnvironment: boolean;
  readonly runHooks: boolean;
  readonly worktreesRoot: string | undefined;
  readonly warnings: readonly SettingWarning[];
}

function boolSetting(name: string, v: ValuesByScope, dflt: boolean, warnings: SettingWarning[]): boolean {
  warnings.push(...ignoredScopeWarnings(name, v));
  const chosen = pick(v);
  if (!chosen) return dflt;
  if (typeof chosen.value !== "boolean") {
    warnings.push({ setting: name, scope: chosen.scope, message: `${name} must be a boolean; using the default.` });
    return dflt;
  }
  return chosen.value;
}

/**
 * Resolves scrubEnvironment (default true), runHooks (default true) and worktrees.root.
 * worktrees.root must be a plain absolute path without '..'; whether it lies inside a registered repository is the daemon's check.
 */
export function resolveSecuritySettings(input: {
  readonly scrubEnvironment?: ValuesByScope;
  readonly runHooks?: ValuesByScope;
  readonly worktreesRoot?: ValuesByScope;
}, opts: { readonly platform?: NodeJS.Platform } = {}): SecuritySettings {
  const platform = opts.platform ?? process.platform;
  const warnings: SettingWarning[] = [];
  const scrubEnvironment = boolSetting("axis.terminals.scrubEnvironment", input.scrubEnvironment ?? {}, true, warnings);
  const runHooks = boolSetting("axis.git.runHooks", input.runHooks ?? {}, true, warnings);
  const rootName = "axis.worktrees.root";
  const rootValues = input.worktreesRoot ?? {};
  warnings.push(...ignoredScopeWarnings(rootName, rootValues));
  let worktreesRoot: string | undefined;
  const chosen = pick(rootValues);
  if (chosen) {
    const v = chosen.value;
    if (typeof v === "string" && v.length > 0 && !v.includes("\0") && isPlainAbsolute(v, platform) && !hasDotDot(v)) {
      worktreesRoot = v;
    } else {
      warnings.push({ setting: rootName, scope: chosen.scope, message: `${rootName} must be a plain absolute path without '..' (on Windows a drive-letter path; UNC and root-relative paths are refused); using the default.` });
    }
  }
  return { scrubEnvironment, runHooks, worktreesRoot, warnings };
}
