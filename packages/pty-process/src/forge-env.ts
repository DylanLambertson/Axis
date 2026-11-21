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

/** The marker set's version; it changes with the gate that confirms the texts (§7). 2: phrases only, names removed (review S1b D-1, D-2). */
export const FORGE_STDERR_MARKERS_VERSION = 2;

/**
 * Fixed markers, matched case-insensitively on the first 64 KiB of stderr after the repository's own names are removed; the
 * first class with a match wins, in the order of `classifyForgeStderr`. Every marker is a phrase of `gh`'s or go-keyring's own
 * messages and holds a space, so no vetted name (which cannot hold one) can be a marker by itself (review S1b SF-1, D-2).
 */
export const FORGE_STDERR_MARKERS = Object.freeze({
  repo_missing: Object.freeze(["could not resolve to a repository"]),
  keyring: Object.freeze(["name org.freedesktop.secrets", "secret service", "secret not found in keyring", "from keyring", "to keyring", "couldn't find oauth token", "failed to migrate"]),
  network: Object.freeze(["dial tcp", "no such host", "connection refused", "connection reset", "network is unreachable", "i/o timeout", "tls handshake timeout", "could not connect to"]),
});
/**
 * `gh`'s own API error line, at the start of a line: `HTTP 401: Bad credentials (https://api.github.com/graphql)`. A line starts
 * after LF only (`\r\n` included); a lone CR, U+2028, U+2029 or NEL does not start one (review S1b-2 N-1: the `m` flag counted them).
 */
const HTTP_401 = /(?:^|\n)HTTP 401(?::|\s|$)/;
/** What a removed name leaves: no marker holds it, so text on either side of a name never joins into one. */
const GAP = "\u0001";

const NAME_CHAR = "A-Za-z0-9._-";
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * `gh` echoes the repository it was asked about (`... with the name 'acme/python-keyring'.`). Every case-insensitive occurrence of
 * `owner/repo`, then of the longer and the shorter of the two names, that does not continue a name to its left is removed,
 * whatever follows it (review S1b D-1: a sentence's closing `.` after `org.freedesktop.secrets` once kept the name). A name
 * shorter than `SHORT_NAME` is removed only as a whole token, so an owner `o` does not eat the start of `org` (review S1b-2 N-2).
 * Removing too much only loses a marker (the class falls to `other`); it can never make one.
 */
const SHORT_NAME = 3;
export function withoutNames(stderr: string, owner: string, repo: string): string {
  let text = stderr;
  const parts = [repo, owner].sort((a, b) => b.length - a.length);
  for (const name of [`${owner}/${repo}`, ...parts]) {
    if (name === "" || name === "/") continue;
    const end = name.length < SHORT_NAME ? "(?![A-Za-z0-9_-])" : ""; // a closing '.' still ends it (D-1)
    text = text.replace(new RegExp(`(?<![${NAME_CHAR}])${escape(name)}${end}`, "gi"), GAP);
  }
  return text;
}

/**
 * The closed class of a finished call (§7). Exit 0 is `none` whatever stderr says. Then, on the text without the repository's
 * names: `repo_missing`; and only on `gh`'s error exits (1, or 4 for authentication) `keyring` and `auth_missing` (exit 4, or
 * exit 1 with `gh`'s `HTTP 401` line); then `network`, else `other`. The text itself is never returned.
 */
export function classifyForgeStderr(exit: number | null, stderr: string, owner: string, repo: string): ForgeStderrClass {
  if (exit === 0) return "none";
  const bare = withoutNames(stderr, owner, repo);
  const text = bare.toLowerCase();
  const has = (markers: readonly string[]): boolean => markers.some((m) => text.includes(m));
  if (has(FORGE_STDERR_MARKERS.repo_missing)) return "repo_missing";
  if (exit === 1 || exit === 4) {
    if (has(FORGE_STDERR_MARKERS.keyring)) return "keyring";
    if (exit === 4 || HTTP_401.test(bare)) return "auth_missing";
  }
  if (has(FORGE_STDERR_MARKERS.network)) return "network";
  return "other";
}
