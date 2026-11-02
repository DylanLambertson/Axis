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
}

export interface PlainTerminalEnvOptions extends CliEnvOptions {
  /** Profile env and terminal.integrated.env.*; applied before the deny-list, so it cannot re-add a denied name. */
  readonly userEnv?: EnvLike;
  /** Output of getShellIntegrationInjection, restricted to SI_ENV_NAMES. Added after the deny-list. */
  readonly shellIntegration?: EnvLike;
}

function keyOf(name: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? canonical(name) : name;
}

function mergeSources(sources: readonly EnvLike[], platform: NodeJS.Platform): Map<string, [string, string | undefined]> {
  const m = new Map<string, [string, string | undefined]>();
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

function sanitize(
  merged: Map<string, [string, string | undefined]>,
  opts: CliEnvOptions,
): { env: Record<string, string>; removed: Removal[] } {
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
    if (!isValidName(name) || value.includes("\0")) {
      removed.push({ name, reason: "invalid" });
      continue;
    }
    const denied = classifyDeniedName(name);
    if (denied) {
      removed.push({ name, reason: denied });
      continue;
    }
    const c = canonical(name);
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

function restoreNodeOptions(env: Record<string, string>, source: EnvLike, platform: NodeJS.Platform): void {
  let original: string | undefined;
  for (const name of Object.keys(source)) {
    if (canonical(name) === "VSCODE_NODE_OPTIONS" && typeof source[name] === "string" && source[name] !== "") {
      original = source[name];
    }
  }
  if (original === undefined || original.includes("\0")) return;
  const existing = Object.keys(env).find((n) => keyOf(n, platform) === keyOf("NODE_OPTIONS", platform));
  env[existing ?? "NODE_OPTIONS"] = original;
}

/** PTY-5 for a CLI agent run. Shell integration is never available here: no nonce can be supplied. */
export function buildCliEnv(parentEnv: EnvLike, opts: CliEnvOptions = {}): BuiltEnv {
  const platform = opts.platform ?? process.platform;
  const merged = mergeSources([parentEnv], platform);
  const { env, removed } = sanitize(merged, opts);
  restoreNodeOptions(env, parentEnv, platform);
  return { env, removed: [...removed, ...caseDuplicates(parentEnv, platform)] };
}

/** PTY-5 plus SI-ENV for a plain workspace terminal. SI-ENV is the only thing set after the deny-list. */
export function buildPlainTerminalEnv(parentEnv: EnvLike, opts: PlainTerminalEnvOptions = {}): BuiltEnv {
  const platform = opts.platform ?? process.platform;
  const merged = mergeSources([parentEnv, opts.userEnv ?? {}], platform);
  const { env, removed } = sanitize(merged, opts);
  restoreNodeOptions(env, parentEnv, platform);
  const si = opts.shellIntegration ?? {};
  const extra: Removal[] = [];
  for (const name of Object.keys(si)) {
    const value = si[name];
    if (value === undefined) continue;
    if (UNSAFE_KEYS.has(name) || !isValidName(name) || value.includes("\0")) {
      extra.push({ name, reason: UNSAFE_KEYS.has(name) ? "unsafe-key" : "invalid" });
    } else if (!SI_ENV_NAMES.has(canonical(name))) {
      extra.push({ name, reason: "si-env-not-allowed" });
    } else {
      env[canonical(name)] = value;
    }
  }
  return { env, removed: [...removed, ...caseDuplicates(parentEnv, platform), ...extra] };
}

function caseDuplicates(source: EnvLike, platform: NodeJS.Platform): Removal[] {
  if (platform !== "win32") return [];
  const seen = new Set<string>();
  const out: Removal[] = [];
  for (const name of Object.keys(source)) {
    const c = canonical(name);
    if (seen.has(c)) out.push({ name, reason: "duplicate-case" });
    seen.add(c);
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
 * GIT_TERMINAL_PROMPT=0. Every other variable, including every GIT_*, is dropped.
 */
export function buildGitEnv(parentEnv: EnvLike, opts: { readonly platform?: NodeJS.Platform } = {}): BuiltEnv {
  const platform = opts.platform ?? process.platform;
  const allow = new Set(platform === "win32" ? [...GIT_ALLOW, ...GIT_ALLOW_WIN32] : GIT_ALLOW);
  const env: Record<string, string> = {};
  const removed: Removal[] = [];
  const seen = new Set<string>();
  for (const name of Object.keys(parentEnv)) {
    const value = parentEnv[name];
    if (value === undefined) continue;
    if (UNSAFE_KEYS.has(name)) {
      removed.push({ name, reason: "unsafe-key" });
      continue;
    }
    const c = canonical(name);
    const key = platform === "win32" ? c : name;
    const ok = allow.has(key) || key.startsWith("LC_");
    if (!isValidName(name) || value.includes("\0")) {
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
