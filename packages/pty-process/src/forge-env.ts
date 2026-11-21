// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// What the pty process gives `gh` for a `forge-list` call (docs/design/forge-pr-list.md §1, §4, §7): the closed command
// templates, the environment built from an allow-list, the generated configuration and the stderr classifier.
import { FORGE_HOST, type ForgeStderrClass } from "@axis/protocol";
import { hasNul } from "./paths.js";

/** The JSON fields `forge-list` asks for; the daemon's parse reads exactly these (§5). */
export const FORGE_JSON_FIELDS = "number,title,headRefName,author,isDraft,isCrossRepository,headRepositoryOwner,reviewDecision,statusCheckRollup";

/**
 * The one list command (§1). Every value is joined to its flag, so nothing can be read as a flag. `authorFilter: false` is the
 * gate's fallback template: the plain 50-row window, no `--author`.
 */
export function forgeListArgv(ghPath: string, owner: string, repo: string, authorFilter: boolean): string[] {
  return [
    ghPath, "pr", "list", `--repo=${FORGE_HOST}/${owner}/${repo}`, "--state=open",
    ...(authorFilter ? ["--author=@me"] : []),
    "--limit=50", `--json=${FORGE_JSON_FIELDS}`,
  ];
}

/** The only other command: the version step, no message input (§1). */
export const forgeVersionArgv = (ghPath: string): string[] => [ghPath, "--version"];

export type GhVersion = readonly [number, number, number];
/** The first `gh` that reads `version: "1"` without migrating (§4; confirmed by the slice 2 gate). */
export const MIN_GH_VERSION: GhVersion = [2, 40, 0];

/**
 * `gh version 2.40.0 (2023-12-07)` as the whole first line, nothing else on it: ANSI, a prefix, a long line or no version is
 * unknown. The rest of the output (the release link) is not read.
 */
export function parseGhVersion(stdout: string): GhVersion | undefined {
  const nl = stdout.indexOf("\n");
  const first = nl === -1 ? stdout : stdout.slice(0, nl);
  const m = /^gh version (\d{1,4})\.(\d{1,4})\.(\d{1,4})(?: \(\d{4}-\d{2}-\d{2}\))?\r?$/.exec(first);
  return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])];
}

export const ghAtLeast = (v: GhVersion, floor: GhVersion): boolean => {
  for (let i = 0; i < 3; i++) if ((v[i] as number) !== (floor[i] as number)) return (v[i] as number) > (floor[i] as number);
  return true;
};

/**
 * The generated `config.yml` (§4): `version: "1"` stops the multi-account migration (an API call, a keyring write and a
 * `hosts.yml` rewrite on every call); no aliases, no `http_unix_socket`, empty pager, browser and editor.
 */
export const FORGE_CONFIG_YML = 'version: "1"\ngit_protocol: https\nprompt: disabled\npager: ""\nbrowser: ""\neditor: ""\n';
/** The generated `hosts.yml`: the one host, no `user`, `users` or `oauth_token` key, so `gh` reads the keyring's active account. */
export const FORGE_HOSTS_YML = `${FORGE_HOST}:\n    git_protocol: https\n`;
/** The generated files, by name; the call's `config/` holds exactly these bytes and nothing else before the exec. */
export const FORGE_CONFIG_FILES: Readonly<Record<string, string>> = Object.freeze({ "config.yml": FORGE_CONFIG_YML, "hosts.yml": FORGE_HOSTS_YML });

const COPY_ALL = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"];
const COPY_LINUX = ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"];
const COPY_WINDOWS = ["SYSTEMROOT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"];
const LC_NAME = /^LC_[A-Z]{1,32}$/;

/** The directories of one call (§1): `cwd/`, `config/` and `data/` exist; the XDG state and cache homes are created by `gh` if at all. */
export interface ForgeCallDirs {
  readonly cwd: string;
  readonly config: string;
  readonly data: string;
  readonly state: string;
  readonly cache: string;
}

/**
 * The environment of a `gh` call, built from nothing (§4): the allow-listed names copied from the pty process's own startup
 * environment (exact names; a value holding NUL is skipped), then the pinned directories and switches. Tokens, `GH_REPO`,
 * `GH_PATH`, pagers, browsers, editors, debug switches and loader variables are absent because nothing else is copied.
 */
export function buildForgeEnv(base: Readonly<Record<string, string | undefined>>, dirs: ForgeCallDirs, platform: NodeJS.Platform): Record<string, string> {
  const env: Record<string, string> = Object.create(null) as Record<string, string>;
  const names = [...COPY_ALL, ...(platform === "linux" ? COPY_LINUX : []), ...(platform === "win32" ? COPY_WINDOWS : [])];
  for (const name of Object.keys(base)) if (LC_NAME.test(name)) names.push(name);
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(base, name)) continue;
    const value = base[name];
    if (typeof value === "string" && !hasNul(value)) env[name] = value;
  }
  env["GH_CONFIG_DIR"] = dirs.config;
  env["XDG_CONFIG_HOME"] = dirs.config;
  env["XDG_DATA_HOME"] = dirs.data;
  env["XDG_STATE_HOME"] = dirs.state;
  env["XDG_CACHE_HOME"] = dirs.cache;
  env["GH_HOST"] = FORGE_HOST;
  env["GH_PROMPT_DISABLED"] = "1";
  env["GH_NO_UPDATE_NOTIFIER"] = "1";
  env["GH_NO_EXTENSION_UPDATE_NOTIFIER"] = "1";
  env["GH_SPINNER_DISABLED"] = "1";
  env["NO_COLOR"] = "1";
  env["CLICOLOR"] = "0";
  return env;
}

/** The marker set's version; it changes with the gate that confirms the texts (§7). */
export const FORGE_STDERR_MARKERS_VERSION = 1;

/**
 * Fixed markers, matched case-insensitively on the first 64 KiB of stderr; the first class with a match wins, in this order.
 * A keyring failure comes first: `gh` reports a locked or missing keyring as "not logged in" too, and the copy differs.
 */
const MARKERS: readonly (readonly [Exclude<ForgeStderrClass, "none" | "other" | "auth_missing">, readonly string[]])[] = [
  ["keyring", ["org.freedesktop.secrets", "secret service", "keyring", "couldn't find oauth token", "failed to migrate"]],
  ["repo_missing", ["could not resolve to a repository"]],
  ["network", ["dial tcp", "no such host", "connection refused", "connection reset", "network is unreachable", "i/o timeout", "tls handshake timeout", "could not connect to"]],
];

/**
 * The closed class of a finished call (§7). Exit 0 is `none` whatever stderr says. Exit 4, or exit 1 with `HTTP 401`, is
 * `auth_missing` unless a keyring marker matched first. The text itself is never returned.
 */
export function classifyForgeStderr(exit: number | null, stderr: string): ForgeStderrClass {
  if (exit === 0) return "none";
  const text = stderr.toLowerCase();
  const [keyring, ...rest] = MARKERS;
  if (keyring !== undefined && keyring[1].some((m) => text.includes(m))) return keyring[0];
  if (exit === 4 || (exit === 1 && stderr.includes("HTTP 401"))) return "auth_missing";
  for (const [cls, markers] of rest) if (markers.some((m) => text.includes(m))) return cls;
  return "other";
}
