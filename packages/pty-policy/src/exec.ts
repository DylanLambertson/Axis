// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Executable resolution done by Axis, never by the pty (threat model: a repository-controlled cwd must not win).
import { statSync, accessSync, constants } from "node:fs";
import { delimiterOf, isInside, isPlainAbsolute, joinPath } from "./paths.js";

export interface ExecFs {
  /** True for a regular file the user can execute. */
  isExecutableFile(path: string): boolean;
}

export const nodeFs: ExecFs = {
  isExecutableFile(path: string): boolean {
    try {
      if (!statSync(path).isFile()) return false;
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/** Batch files run through cmd.exe, which interprets `& | % ^ "` in arguments. Not launchable. */
export function isBatchName(name: string): boolean {
  const n = name.replace(/[. ]+$/, "").toLowerCase();
  return n.endsWith(".bat") || n.endsWith(".cmd");
}

export interface ResolveOptions {
  /** Directories whose contents must never win, such as the worktree root, even when PATH names them. */
  readonly excludeDirs?: readonly string[];
}

function pathValue(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): string {
  for (const k of Object.keys(env)) {
    if ((platform === "win32" ? k.toUpperCase() : k) === "PATH" && typeof env[k] === "string") return env[k] as string;
  }
  return "";
}

function pathExt(env: Readonly<Record<string, string | undefined>>): string[] {
  let raw = ".COM;.EXE";
  for (const k of Object.keys(env)) if (k.toUpperCase() === "PATHEXT" && typeof env[k] === "string") raw = env[k] as string;
  return raw.split(";").map((e) => e.trim()).filter((e) => /^\.[A-Za-z0-9]+$/.test(e) && !isBatchName(`x${e}`));
}

/**
 * Resolves a bare command name against PATH only. Empty entries, relative entries (including `.`), the current
 * directory and any `excludeDirs` are ignored. On win32 PATHEXT applies, minus `.bat` and `.cmd`. Returns an
 * absolute path, or undefined.
 */
export function resolveExecutable(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  fs: ExecFs,
  opts: ResolveOptions = {},
): string | undefined {
  if (!/^[A-Za-z0-9._+-]+$/.test(name) || name === "." || name === "..") return undefined;
  const exts = platform === "win32" ? pathExt(env) : [];
  const names = platform === "win32" ? [...(exts.some((e) => name.toLowerCase().endsWith(e.toLowerCase())) ? [name] : []), ...exts.map((e) => name + e)] : [name];
  for (const dir of pathValue(env, platform).split(delimiterOf(platform))) {
    if (dir.length === 0 || !isPlainAbsolute(dir, platform)) continue;
    if ((opts.excludeDirs ?? []).some((x) => isInside(dir, x, platform))) continue;
    for (const n of names) {
      const candidate = joinPath(dir, n, platform);
      if (fs.isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

const BATCH_HINT = "Batch files (.bat, .cmd) run through cmd.exe and cannot be launched safely; point the agent at the real .exe, or use node with the script.";

/**
 * Platform rules for command[0]. Returns a reason when it must be refused, undefined when acceptable.
 * win32: a bare name or a drive-letter absolute path; no UNC, device or root-relative path; no .bat or .cmd.
 * Other platforms: a bare name or a POSIX absolute path.
 */
export function checkExecutable(command0: string, platform: NodeJS.Platform): string | undefined {
  const bare = /^[A-Za-z0-9._+-]+$/.test(command0) && command0 !== "." && command0 !== "..";
  if (!bare && !isPlainAbsolute(command0, platform)) {
    return platform === "win32"
      ? "command[0] must be a bare executable name or a drive-letter absolute path (UNC and root-relative paths are refused)"
      : "command[0] must be a bare executable name or an absolute path";
  }
  if (platform === "win32" && isBatchName(command0)) return BATCH_HINT;
  return undefined;
}
