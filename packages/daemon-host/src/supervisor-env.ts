// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The daemon's environment allow-list, the start gate and the data roots (split from supervisor.ts, which re-exports them).
import type { SupervisedConfig } from "./supervisor.js";

/** The names main lets through to the daemon (design 3, step 2: nothing a renderer can influence). `NODE_OPTIONS` is never one. */
export const DAEMON_ENV_ALLOW = Object.freeze(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_RUNTIME_DIR", "PATHEXT", "WINDIR", "COMSPEC", "USERNAME", "HOMEDRIVE", "HOMEPATH"] as const);

/** The environment of the daemon process: the allow-listed names of `source` that are strings, nothing else. */
export function daemonEnvironment(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of DAEMON_ENV_ALLOW) {
    const value = source[name];
    if (typeof value === "string") env[name] = value;
  }
  return env;
}

/**
 * Whether main starts the daemon, and with it the pty process (PV-X1b: one gate for both). Only in a development build until the
 * owner's packaging ADR: a built (packaged) app starts neither. `isBuilt` is Code OSS's `environmentMainService.isBuilt` (false only
 * under `VSCODE_DEV`), never Electron's `app.isPackaged`, which is true for every Code OSS executable (it is never named `electron`).
 */
export const shouldStartDaemon = (isBuilt: boolean): boolean => !isBuilt;

export interface AxisDataRoots {
  readonly dataDir: string;
  readonly worktreeRoot: string;
}

const isAbsoluteFor = (platform: SupervisedConfig["platform"], p: string): boolean =>
  platform === "win32" ? /^[A-Za-z]:[\\/]/.test(p) : p.startsWith("/");

/**
 * Where the daemon keeps its database and the managed worktrees (design D-3, ADR 0004 decision 7), per platform and NOT under
 * Electron's `userData` (Linux: the config directory; Windows: Roaming AppData, which a domain profile syncs; and it follows
 * `--user-data-dir`):
 * - macOS `<home>/Library/Application Support/Axis`;
 * - Linux `$XDG_DATA_HOME/Axis`, default `<home>/.local/share/Axis` (a relative or empty `XDG_DATA_HOME` is ignored, as the XDG spec says);
 * - Windows `%LOCALAPPDATA%\Axis`, default `<home>\AppData\Local\Axis`.
 * `dataDir` is `<base>/daemon` and `worktreeRoot` is `<base>/worktrees`, so both share one anchor. Pure: `env` and `home` come in.
 */
export function axisDataRoots(platform: SupervisedConfig["platform"], env: Readonly<Record<string, string | undefined>>, home: string): AxisDataRoots {
  const sep = platform === "win32" ? "\\" : "/";
  const clean = (p: string): string => p.replace(/[\\/]+$/, "");
  const usable = (v: string | undefined): v is string => typeof v === "string" && v !== "" && !v.includes("\0") && isAbsoluteFor(platform, v);
  let base: string;
  if (platform === "darwin") base = `${clean(home)}/Library/Application Support/Axis`;
  else if (platform === "win32") base = `${clean(usable(env["LOCALAPPDATA"]) ? (env["LOCALAPPDATA"] as string) : `${clean(home)}\\AppData\\Local`)}\\Axis`;
  else base = `${clean(usable(env["XDG_DATA_HOME"]) ? (env["XDG_DATA_HOME"] as string) : `${clean(home)}/.local/share`)}/Axis`;
  return { dataDir: `${base}${sep}daemon`, worktreeRoot: `${base}${sep}worktrees` };
}
