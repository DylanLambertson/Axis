// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// TODO: switch to `import { buildGitEnv } from "@axis/pty-policy"` once that package is merged.
// This is a copy of its GIT-ENV-1 semantics: an allow-list, GIT_TERMINAL_PROMPT=0, and no other GIT_*.
import type { Env } from "./types.js";

const ALLOW = new Set(["PATH", "HOME", "USER", "LANG", "TMPDIR"]);
const ALLOW_WIN32 = new Set([
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "TEMP", "TMP", "HOMEDRIVE", "HOMEPATH",
]);
const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

export function daemonGitEnv(parent: Env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const env: Record<string, string> = {};
  const seen = new Set<string>();
  for (const name of Object.keys(parent)) {
    const value = parent[name];
    if (value === undefined || UNSAFE.has(name) || name.includes("=") || name.includes("\0") || value.includes("\0")) continue;
    const c = name.toUpperCase();
    const key = platform === "win32" ? c : name;
    const ok = ALLOW.has(key) || key.startsWith("LC_") || (platform === "win32" && ALLOW_WIN32.has(key));
    if (!ok || seen.has(c)) continue;
    seen.add(c);
    env[name] = value;
  }
  env["GIT_TERMINAL_PROMPT"] = "0";
  return env;
}

/** Variables that would override the identity git takes from the repository config, or the repository location. */
const OVERRIDES = new RegExp(
  [
    "^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$", "^GIT_CONFIG",
    // Where the repository, its refs and its objects are, so what git writes can differ from what the daemon verifies.
    "^GIT_DIR$", "^GIT_WORK_TREE$", "^GIT_INDEX_FILE$", "^GIT_COMMON_DIR$", "^GIT_PREFIX$", "^GIT_NAMESPACE$",
    "^GIT_OBJECT_DIRECTORY$", "^GIT_ALTERNATE_OBJECT_DIRECTORIES$", "^GIT_SHALLOW_FILE$",
    "^GIT_CEILING_DIRECTORIES$", "^GIT_DISCOVERY_ACROSS_FILESYSTEM$",
    // refs/replace: pack-objects ignores it, and the daemon's reads must agree with it.
    "^GIT_REPLACE_REF_BASE$", "^GIT_NO_REPLACE_OBJECTS$",
    "^GIT_EXEC_PATH$",
  ].join("|"),
  "i",
);

/** The name of an environment variable that tries to override identity, config or repository location. */
export function findOverride(env: Env): string | undefined {
  return Object.keys(env).find((n) => env[n] !== undefined && OVERRIDES.test(n));
}

export function withNoPrompt(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of Object.keys(env)) {
    const v = env[n];
    if (v !== undefined && !UNSAFE.has(n) && n.toUpperCase() !== "GIT_TERMINAL_PROMPT") out[n] = v;
  }
  out["GIT_TERMINAL_PROMPT"] = "0";
  return out;
}
