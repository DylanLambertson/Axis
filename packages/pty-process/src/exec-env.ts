// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The `exec` environment is BUILT by the service, not filtered from the caller's (docs/design/daemon-host-hooks.md §4.1, §4.3).
import { classifyDeniedName, isValidName } from "@axis/pty-policy";
import { hasNul } from "./paths.js";

/** The only names a message may set on `exec`. Anything else (GIT_CONFIG_GLOBAL, HOME, GIT_SSH*, GIT_TRACE*, ...) is `env_denied`. */
const EXEC_ALLOW = new Set([
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_DATE",
  "GIT_TERMINAL_PROMPT", "LANG",
]);

export const execNameAllowed = (name: string): boolean => {
  const n = name.toUpperCase();
  return isValidName(name) && (EXEC_ALLOW.has(n) || /^LC_[A-Z0-9_]{1,64}$/.test(n));
};

/**
 * Names the startup environment may hold that would undo a pin or move git: the protocol override beats `protocol.allow`,
 * the replace-ref base and lazy-fetch switch are set by the service, and pager or editor variables have no business in a
 * bounded call. Removed from the base, whatever their case.
 */
const BASE_DROP = new Set([
  "GIT_ALLOW_PROTOCOL", "GIT_PROTOCOL_FROM_USER", "GIT_REPLACE_REF_BASE", "GIT_NO_REPLACE_OBJECTS", "GIT_NO_LAZY_FETCH",
  "GIT_OPTIONAL_LOCKS", "GIT_EXTERNAL_DIFF", "GIT_PAGER", "PAGER", "EDITOR", "VISUAL", "GIT_SEQUENCE_EDITOR",
  "GIT_SHALLOW_FILE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM",
]);
/** Config-location names a bound call replaces with the service's own empty files. */
const CONFIG_LOCATION = new Set(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "HOME", "XDG_CONFIG_HOME"]);

/** Whether a message `env` (spawn, hook) passes the PTY-5 re-check: valid names, none denied, no NUL value. */
export function pty5Clean(env: Readonly<Record<string, string>>): boolean {
  for (const [name, value] of Object.entries(env)) if (!isValidName(name) || classifyDeniedName(name) !== undefined || hasNul(value)) return false;
  return true;
}

/** How a bound call isolates itself from user-level config, picked once from the git version (§4.3). */
export type ConfigIsolation =
  | { readonly kind: "env"; readonly emptyFile: string }
  | { readonly kind: "home"; readonly emptyDir: string };

export interface BoundRedirect {
  readonly gitDir: string;
  readonly workTree: string;
  readonly indexFile: string;
}

/**
 * The environment of an exec: the startup environment minus denied and pin-undoing names, plus the allow-listed message
 * names, plus what the service sets itself. Returns undefined when the message names anything outside the allow-list.
 */
export function buildExecEnv(
  base: Readonly<Record<string, string | undefined>>,
  message: Readonly<Record<string, string>>,
  bound: { readonly redirect: BoundRedirect; readonly isolation: ConfigIsolation } | undefined,
): Record<string, string> | undefined {
  for (const [name, value] of Object.entries(message)) if (!execNameAllowed(name) || hasNul(value)) return undefined;
  const env: Record<string, string> = {};
  const seen = new Set<string>();
  const put = (name: string, value: string): void => {
    const c = name.toUpperCase();
    for (const k of Object.keys(env)) if (k.toUpperCase() === c) delete env[k];
    env[name] = value;
    seen.add(c);
  };
  for (const [name, value] of Object.entries(base)) {
    const c = name.toUpperCase();
    if (value === undefined || !isValidName(name) || hasNul(value) || classifyDeniedName(name) !== undefined || BASE_DROP.has(c)) continue;
    if (bound !== undefined && CONFIG_LOCATION.has(c)) continue;
    if (seen.has(c)) continue;
    put(name, value);
  }
  for (const [name, value] of Object.entries(message)) put(name, value);
  put("GIT_NO_LAZY_FETCH", "1");
  // A transport allow-list naming no transport. It overrides every protocol.* setting on every git since 2.12, so a
  // repository `protocol.file.allow=always` cannot re-enable the lazy fetch that GIT_NO_LAZY_FETCH stops only from 2.44.
  put("GIT_ALLOW_PROTOCOL", "none");
  if (bound !== undefined) {
    put("GIT_DIR", bound.redirect.gitDir);
    put("GIT_WORK_TREE", bound.redirect.workTree);
    put("GIT_INDEX_FILE", bound.redirect.indexFile);
    put("GIT_NO_REPLACE_OBJECTS", "1");
    put("GIT_OPTIONAL_LOCKS", "0");
    if (bound.isolation.kind === "env") {
      put("GIT_CONFIG_GLOBAL", bound.isolation.emptyFile);
      put("GIT_CONFIG_SYSTEM", bound.isolation.emptyFile);
    } else {
      put("GIT_CONFIG_NOSYSTEM", "1");
      put("HOME", bound.isolation.emptyDir);
      put("XDG_CONFIG_HOME", bound.isolation.emptyDir);
    }
  }
  return env;
}

/** A hook's environment: the PTY-5-clean message env, the three redirectors derived by the service, and no replace refs. */
export function buildHookEnv(message: Readonly<Record<string, string>>, redirect: BoundRedirect): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(message)) if (name.toUpperCase() !== "GIT_NO_REPLACE_OBJECTS") env[name] = value;
  env["GIT_DIR"] = redirect.gitDir;
  env["GIT_WORK_TREE"] = redirect.workTree;
  env["GIT_INDEX_FILE"] = redirect.indexFile;
  env["GIT_NO_REPLACE_OBJECTS"] = "1";
  return env;
}
