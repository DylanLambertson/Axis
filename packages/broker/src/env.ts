// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PTY-2: the environment of a broker tool process is an allow-list, never a filtered copy of the parent.
import { SECRET_NAME_PATTERN, UNSAFE_KEYS, canonical, classifyDeniedName, delimiterOf, isInside, isPlainAbsolute, isValidName } from "@axis/pty-policy";
import { invalid } from "./errors.js";
import type { Env } from "./types.js";

/** Always present (when the parent has them). */
export const BASE_NAMES = ["PATH", "HOME", "LANG", "TERM"] as const;
const MAX_VALUE = 8192;
const MAX_VARS = 128;

export interface EnvGrant {
  readonly tool: string;
  readonly worktreeId: string;
  readonly name: string;
  /** Comes from the grant source (the vault), never from the parent environment. */
  readonly value: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

/** Scoped secret grants for one child environment. Implemented by the vault later (PRV-2). */
export interface EnvGrantSource {
  grantsFor(tool: string, worktreeId: string): readonly EnvGrant[];
}

export interface ToolEnvSpec {
  readonly tool: string;
  readonly worktreeId: string;
  /** Names copied from the parent in addition to the base four. */
  readonly additions?: readonly string[];
  /** Fixed values the tool declares. */
  readonly fixed?: Readonly<Record<string, string>>;
}
export interface ToolEnvOptions {
  readonly platform?: NodeJS.Platform;
  readonly now: number;
  readonly grants?: readonly EnvGrant[];
  /** Directories that must not appear on PATH (the worktree root, registered repositories). */
  readonly excludeDirs?: readonly string[];
}
export type EnvRemovalReason = "denied" | "injection" | "secret-name" | "invalid" | "grant-refused" | "limit";
export interface BuiltToolEnv {
  readonly env: Record<string, string>;
  /** Names, never values. */
  readonly removed: readonly { readonly name: string; readonly reason: EnvRemovalReason }[];
}

/** Variables that make a program load or run attacker-chosen code, or choose the program a tool starts. */
const INJECTION = /^(?:LD_.*|DYLD_.*|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|ENV|PROMPT_COMMAND|PS4|SHELLOPTS|BASHOPTS|IFS|CDPATH|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PYTHONUSERBASE|RUBYOPT|RUBYLIB|PERL5OPT|PERL5LIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|CLASSPATH|GCONV_PATH|LOCPATH|NLSPATH|GLIBC_TUNABLES|MALLOC_.*|LESSOPEN|LESSCLOSE|PAGER|GIT_PAGER|EDITOR|VISUAL|BROWSER|GIT_SSH|GIT_SSH_COMMAND|GIT_PROXY_COMMAND|GIT_EXTERNAL_DIFF|GIT_CONFIG_.*|GIT_DIR|GIT_WORK_TREE|COMSPEC)$/;
/** Names whose value is a secret or a handle to one. A grant is the only way in. */
const SECRET_LIKE = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|PRIVATE|APIKEY|COOKIE|AUTH|SESSION|KEY)(?:_|$)|API_?KEY|ACCESS_KEY|SSH_AUTH_SOCK/;

const looksSecret = (n: string): boolean => SECRET_NAME_PATTERN.test(n) || SECRET_LIKE.test(n);
const badValue = (v: unknown): boolean => typeof v !== "string" || v.includes("\0") || v.length > MAX_VALUE;

/** Names that stay refused even for a grant: editor and extension handles, Axis internals, loader and git redirectors. */
function hardDenied(n: string): boolean {
  const why = classifyDeniedName(n);
  return INJECTION.test(n) || (why !== undefined && why !== "askpass" && why !== "git-editor");
}

/** PATH reduced to absolute entries outside `excludeDirs`: an empty or relative entry would mean the working directory. */
export function sanitizePath(value: string, platform: NodeJS.Platform, excludeDirs: readonly string[]): string {
  const seen = new Set<string>();
  const keep: string[] = [];
  for (const dir of value.split(delimiterOf(platform))) {
    if (!isPlainAbsolute(dir, platform) || excludeDirs.some((x) => isInside(dir, x, platform)) || seen.has(dir)) continue;
    seen.add(dir);
    keep.push(dir);
  }
  return keep.join(delimiterOf(platform));
}

export function buildToolEnv(parent: Env, spec: ToolEnvSpec, opts: ToolEnvOptions): BuiltToolEnv {
  const platform = opts.platform ?? process.platform;
  const env: Record<string, string> = {};
  const removed: { name: string; reason: EnvRemovalReason }[] = [];
  const taken = new Set<string>();
  const key = (n: string): string => (platform === "win32" ? canonical(n) : n);
  const drop = (name: string, reason: EnvRemovalReason): void => {
    if (removed.length < MAX_VARS) removed.push({ name: name.slice(0, 64), reason });
  };
  const put = (name: string, value: string): void => {
    if (taken.size >= MAX_VARS) return drop(name, "limit");
    taken.add(key(name));
    env[platform === "win32" ? canonical(name) : name] = value;
  };
  const find = (name: string): string | undefined => {
    for (const k of Object.keys(parent)) {
      if (key(k) === key(name) && typeof parent[k] === "string") return parent[k];
    }
    return undefined;
  };
  const exclude = opts.excludeDirs ?? [];

  const base = (name: string, value: string | undefined): void => {
    if (value === undefined || badValue(value)) return;
    if (name === "PATH") {
      const p = sanitizePath(value, platform, exclude);
      if (p !== "") put(name, p);
    } else if (name === "HOME" ? isPlainAbsolute(value, platform) : /^[A-Za-z0-9._@+:-]{1,64}$/.test(value)) {
      put(name, value);
    }
  };
  for (const n of BASE_NAMES) base(n, find(n));

  // Scoped grants first: they decide which sensitive names may appear at all.
  const granted = new Map<string, string>();
  for (const g of opts.grants ?? []) {
    const ok = g !== null && typeof g === "object" && g.tool === spec.tool && g.worktreeId === spec.worktreeId &&
      typeof g.expiresAt === "number" && Number.isFinite(g.expiresAt) && g.expiresAt > opts.now;
    if (!ok) continue; // a grant for another tool, worktree or time is not ours to report on
    if (typeof g.name !== "string" || !isValidName(g.name) || UNSAFE_KEYS.has(g.name) || hardDenied(canonical(g.name)) || badValue(g.value)) {
      drop(String(g.name), "grant-refused");
      continue;
    }
    granted.set(key(g.name), g.value);
    put(g.name, g.value);
  }

  const declared = [...(spec.additions ?? []), ...Object.keys(spec.fixed ?? {})];
  for (const name of declared) {
    if (typeof name !== "string" || !isValidName(name) || UNSAFE_KEYS.has(name) || name.length > 128) {
      drop(String(name), "invalid");
      continue;
    }
    if (granted.has(key(name)) || taken.has(key(name))) continue;
    const up = canonical(name);
    if (hardDenied(up)) {
      drop(name, INJECTION.test(up) ? "injection" : "denied");
    } else if (classifyDeniedName(up) !== undefined) {
      drop(name, "denied");
    } else if (looksSecret(up)) {
      drop(name, "secret-name");
    } else {
      const fixed = spec.fixed !== undefined && Object.hasOwn(spec.fixed, name) ? spec.fixed[name] : undefined;
      const value = fixed ?? find(name);
      if (value === undefined || badValue(value)) drop(name, "invalid");
      else put(name, value);
    }
  }
  return { env, removed };
}

/** Throws unless `env` is a plain record of strings (what the runner accepts). */
export function assertEnv(env: unknown): asserts env is Record<string, string> {
  if (env === null || typeof env !== "object" || Array.isArray(env)) throw invalid("invalid-env", "the environment is not valid");
  const names = Object.keys(env);
  if (names.length > MAX_VARS) throw invalid("invalid-env", "the environment is not valid");
  for (const n of names) {
    const v = (env as Record<string, unknown>)[n];
    if (!isValidName(n) || UNSAFE_KEYS.has(n) || badValue(v)) throw invalid("invalid-env", "the environment is not valid");
  }
}
