// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Environment-name rules shared by the PTY-5 deny-list, SI-ENV and GIT-ENV-1.
// Names are compared case-insensitively on EVERY platform: Windows treats env
// names as case-insensitive, and denying a lower-case variant on POSIX costs
// nothing.

export type RemovalReason =
  | "vscode"
  | "electron"
  | "askpass"
  | "git-editor"
  | "git-redirect"
  | "git-config"
  | "axis-internal"
  | "extension-collection"
  | "secret-name"
  | "si-env-not-allowed"
  | "not-allow-listed"
  | "unsafe-key"
  | "invalid"
  | "duplicate-case";

/** Prototype-polluting keys. Compared exactly. */
export const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** Git variables that redirect git away from the worktree or inject config (GIT-ENV-1 / PTY-5). */
const GIT_REDIRECT = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_EXEC_PATH",
  "GIT_TEMPLATE_DIR",
]);

/** The shell-integration variables of policies section 4.3. Only plain terminals may receive them. */
export const SI_ENV_NAMES: ReadonlySet<string> = new Set([
  "VSCODE_INJECTION",
  "VSCODE_NONCE",
  "VSCODE_SHELL_ENV_REPORTING",
  "VSCODE_A11Y_MODE",
  "VSCODE_STABLE",
  "VSCODE_SHELL_LOGIN",
  "VSCODE_PATH_PREFIX",
  "ZDOTDIR",
  "USER_ZDOTDIR",
]);

/**
 * Names an extension collection may mention that must never be removed from the user's
 * environment (a collection that prepends to PATH must not delete PATH).
 */
export const ESSENTIAL_NAMES: ReadonlySet<string> = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "SSH_AUTH_SOCK",
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "TEMP", "TMP", "HOMEDRIVE", "HOMEPATH",
]);

/** Broad secret-looking names. Used only when stripSecretNames is requested. */
export const SECRET_NAME_PATTERN = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)(_|$)/;

export function canonical(name: string): string {
  return name.toUpperCase();
}

export function isValidName(name: string): boolean {
  return name.length > 0 && !name.includes("=") && !name.includes("\0");
}

/** The PTY-5 deny-list. Returns the reason, or undefined when the name is not denied. */
export function classifyDeniedName(name: string): RemovalReason | undefined {
  const n = canonical(name);
  if (n.startsWith("VSCODE_")) return "vscode";
  if (n.startsWith("ELECTRON_")) return "electron";
  if (n === "GIT_ASKPASS" || n.startsWith("SSH_ASKPASS")) return "askpass";
  if (n === "GIT_EDITOR") return "git-editor";
  if (n.startsWith("GIT_CONFIG")) return "git-config";
  if (GIT_REDIRECT.has(n)) return "git-redirect";
  if (n.startsWith("AXIS_")) return "axis-internal";
  return undefined;
}
