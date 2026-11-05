// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PTY-5 (CLI agent and workspace terminal environment), SI-ENV and GIT-ENV-1.
// Pure functions: no process.env access, no I/O. Values are never reported.
import {
  ESSENTIAL_NAMES,
  SECRET_NAME_PATTERN,
  SI_ENV_NAMES,
  UNSAFE_KEYS,
  canonical,
  classifyDeniedName,
  isValidName,
  type RemovalReason,
} from "./names.js";
import { isInside } from "./paths.js";

/** Values arrive over IPC, so a value may be of any type; anything that is not a string is dropped as invalid. */
export type EnvLike = Readonly<Record<string, string | undefined>>;
export interface Removal {
  readonly name: string;
  readonly reason: RemovalReason;
}
export interface BuiltEnv {
  readonly env: Record<string, string>;
  /** Names (never values) that were dropped, so the UI can disclose them. */
  readonly removed: readonly Removal[];
}

export interface CliEnvOptions {
  readonly platform?: NodeJS.Platform;
  /** Names any extension environment collection adds, replaces, appends or prepends. Never merged. */
  readonly extensionVariableNames?: readonly string[];
  /** Per-agent envPassthrough. Exempts a name from stripSecretNames only; the deny-list always wins. */
  readonly envPassthrough?: readonly string[];
  /** Also drop secret-looking names (TOKEN, SECRET, API_KEY...). Off by default: a CLI runs under the user's own login. */
  readonly stripSecretNames?: boolean;
  /**
   * Axis's shell-integration directory. An inherited ZDOTDIR that points inside it is removed; any other ZDOTDIR is the
   * user's own and is kept. USER_ZDOTDIR is only meaningful when Axis injects it and is always removed here.
   */
  readonly shellIntegrationDir?: string;
}

export interface PlainTerminalEnvOptions extends CliEnvOptions {
  /** Profile env and terminal.integrated.env.*; applied before the deny-list, so it cannot re-add a denied name. */
  readonly userEnv?: EnvLike;
  /** Output of getShellIntegrationInjection, restricted to SI_ENV_NAMES. Added after the deny-list. */
  readonly shellIntegration?: EnvLike;
}

type Raw = Readonly<Record<string, unknown>>;

const BAD_ENV: Removal = { name: "(environment)", reason: "invalid" };

/** A source that is not a plain object (null, a primitive, an array) is treated as empty and reported, never thrown on. */
function plain(source: unknown, required = false): { raw: Raw; bad: Removal[] } {
  if (source === undefined && !required) return { raw: {}, bad: [] };
  if (source === undefined || source === null || typeof source !== "object" || Array.isArray(source)) return { raw: {}, bad: [BAD_ENV] };
  return { raw: source as Raw, bad: [] };
}
type Merged = Map<string, [string, unknown]>;

function keyOf(name: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? canonical(name) : name;
}

function mergeSources(sources: readonly Raw[], platform: NodeJS.Platform): Merged {
  const m: Merged = new Map();
  for (const src of sources) {
    for (const name of Object.keys(src)) {
      const k = keyOf(name, platform);
      // On Windows a later case variant replaces the earlier one under the first spelling.
      const prev = m.get(k);
      m.set(k, [prev ? prev[0] : name, src[name]]);
    }
  }
  return m;
}

function sanitize(merged: Merged, opts: CliEnvOptions, platform: NodeJS.Platform): { env: Record<string, string>; removed: Removal[] } {
  const env: Record<string, string> = {};
  const removed: Removal[] = [];
  const collection = new Set((opts.extensionVariableNames ?? []).map(canonical));
  const passthrough = new Set((opts.envPassthrough ?? []).map(canonical));
  for (const [name, value] of merged.values()) {
    if (value === undefined) continue;
    if (UNSAFE_KEYS.has(name)) {
      removed.push({ name, reason: "unsafe-key" });
      continue;
    }
    if (typeof value !== "string" || !isValidName(name) || value.includes("\0")) {
      removed.push({ name, reason: "invalid" });
      continue;
    }
    const denied = classifyDeniedName(name);
    if (denied) {
      removed.push({ name, reason: denied });
      continue;
    }
    const c = canonical(name);
    if (c === "USER_ZDOTDIR" || (c === "ZDOTDIR" && opts.shellIntegrationDir !== undefined && isInside(value, opts.shellIntegrationDir, platform))) {
      removed.push({ name, reason: "shell-integration" });
      continue;
    }
    if (collection.has(c) && !ESSENTIAL_NAMES.has(c) && !c.startsWith("LC_")) {
      removed.push({ name, reason: "extension-collection" });
      continue;
    }
    if (opts.stripSecretNames === true && SECRET_NAME_PATTERN.test(c) && !passthrough.has(c)) {
      removed.push({ name, reason: "secret-name" });
      continue;
    }
    env[name] = value;
  }
  return { env, removed };
}

function restoreNodeOptions(env: Record<string, string>, source: Raw, platform: NodeJS.Platform): void {
  let original: string | undefined;
  for (const name of Object.keys(source)) {
    const v = source[name];
    if (canonical(name) === "VSCODE_NODE_OPTIONS" && typeof v === "string" && v !== "") original = v;
  }
  if (original === undefined || original.includes("\0")) return;
  const existing = Object.keys(env).find((n) => keyOf(n, platform) === keyOf("NODE_OPTIONS", platform));
  env[existing ?? "NODE_OPTIONS"] = original;
}

/** PTY-5 for a CLI agent run. Shell integration is never available here: no nonce can be supplied. */
export function buildCliEnv(parentEnv: EnvLike, opts: CliEnvOptions = {}): BuiltEnv {
  const platform = opts.platform ?? process.platform;
  const { raw: parent, bad } = plain(parentEnv, true);
  const { env, removed } = sanitize(mergeSources([parent], platform), opts, platform);
  restoreNodeOptions(env, parent, platform);
  return { env, removed: [...bad, ...removed, ...caseDuplicates([parent], platform)] };
}

/** PTY-5 plus SI-ENV for a plain workspace terminal. SI-ENV is the only thing set after the deny-list. */
export function buildPlainTerminalEnv(parentEnv: EnvLike, opts: PlainTerminalEnvOptions = {}): BuiltEnv {
  const platform = opts.platform ?? process.platform;
  const { raw: parent, bad: badParent } = plain(parentEnv, true);
  const { raw: userEnv, bad: badUser } = plain(opts.userEnv);
  const { raw: si, bad: badSi } = plain(opts.shellIntegration);
  const { env, removed } = sanitize(mergeSources([parent, userEnv], platform), opts, platform);
  restoreNodeOptions(env, parent, platform);
  const extra: Removal[] = [];
  for (const name of Object.keys(si)) {
    const value = si[name];
    if (value === undefined) continue;
    if (UNSAFE_KEYS.has(name)) extra.push({ name, reason: "unsafe-key" });
    else if (typeof value !== "string" || !isValidName(name) || value.includes("\0")) extra.push({ name, reason: "invalid" });
    else if (!SI_ENV_NAMES.has(canonical(name))) extra.push({ name, reason: "si-env-not-allowed" });
    else env[canonical(name)] = value;
  }
  return { env, removed: [...badParent, ...badUser, ...badSi, ...removed, ...caseDuplicates([parent, userEnv], platform), ...extra] };
}

function caseDuplicates(sources: readonly Raw[], platform: NodeJS.Platform): Removal[] {
  if (platform !== "win32") return [];
  const out: Removal[] = [];
  for (const source of sources) {
    const seen = new Set<string>();
    for (const name of Object.keys(source)) {
      const c = canonical(name);
      if (seen.has(c)) out.push({ name, reason: "duplicate-case" });
      seen.add(c);
    }
  }
  return out;
}

const GIT_ALLOW = ["PATH", "HOME", "USER", "LANG", "TMPDIR"];
const GIT_ALLOW_WIN32 = [
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "TEMP", "TMP", "HOMEDRIVE", "HOMEPATH",
];

/**
 * GIT-ENV-1: the environment for daemon git calls other than commit and push. An allow-list
 * (PATH, HOME, USER, LANG, LC_*, TMPDIR, plus the Windows system variables git needs) and
 * GIT_TERMINAL_PROMPT=0. Every other variable, including every GIT_* (GIT_CONFIG_GLOBAL and friends too), is dropped.
 */
export function buildGitEnv(parentEnv: EnvLike, opts: { readonly platform?: NodeJS.Platform } = {}): BuiltEnv {
  const platform = opts.platform ?? process.platform;
  const allow = new Set(platform === "win32" ? [...GIT_ALLOW, ...GIT_ALLOW_WIN32] : GIT_ALLOW);
  const { raw: source, bad } = plain(parentEnv, true);
  const env: Record<string, string> = {};
  const removed: Removal[] = [...bad];
  const seen = new Set<string>();
  for (const name of Object.keys(source)) {
    const value = source[name];
    if (value === undefined) continue;
    if (UNSAFE_KEYS.has(name)) {
      removed.push({ name, reason: "unsafe-key" });
      continue;
    }
    const c = canonical(name);
    const key = platform === "win32" ? c : name;
    const ok = allow.has(key) || key.startsWith("LC_");
    if (typeof value !== "string" || !isValidName(name) || value.includes("\0")) {
      removed.push({ name, reason: "invalid" });
    } else if (!ok) {
      removed.push({ name, reason: "not-allow-listed" });
    } else if (platform === "win32" && seen.has(c)) {
      removed.push({ name, reason: "duplicate-case" });
    } else {
      seen.add(c);
      env[name] = value;
    }
  }
  env["GIT_TERMINAL_PROMPT"] = "0";
  return { env, removed };
}
