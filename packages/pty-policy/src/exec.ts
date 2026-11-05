// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Executable resolution done by Axis, never by the pty (threat model: a repository-controlled cwd must not win).
import * as posix from "node:path/posix";
import * as win32 from "node:path/win32";
import { statSync, accessSync, constants, realpathSync } from "node:fs";
import { delimiterOf, isInside, isPlainAbsolute, joinPath } from "./paths.js";

export interface ExecFs {
  /** True for a regular file the user can execute. */
  isExecutableFile(path: string): boolean;
  /**
   * The canonical path with every symlink resolved (and, on a case-insensitive file system, the on-disk
   * case), or undefined when it cannot be resolved. Optional so that pure tests can omit it; the real
   * `nodeFs` always provides it. When present, containment is judged on real paths, not on spelling.
   */
  realPath?(path: string): string | undefined;
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
  realPath(path: string): string | undefined {
    try {
      return realpathSync.native(path);
    } catch {
      return undefined;
    }
  },
};

/** Real path of `path`, or of its nearest existing ancestor with the rest appended (the file may not exist yet). */
function realOrAncestor(path: string, platform: NodeJS.Platform, fs: ExecFs): string | undefined {
  const lib = platform === "win32" ? win32 : posix;
  let head = path;
  let tail = "";
  for (let i = 0; i < 64; i++) {
    const real = fs.realPath?.(head);
    if (real !== undefined) return tail === "" ? real : lib.join(real, tail);
    const parent = lib.dirname(head);
    if (parent === head) return undefined;
    tail = tail === "" ? lib.basename(head) : lib.join(lib.basename(head), tail);
    head = parent;
  }
  return undefined;
}

/**
 * True when `path` lies inside any of `dirs`, by spelling or, when the file system can resolve symlinks, by real
 * path (so a symlink into a directory, or a different spelling of its case, does not get around the rule).
 */
export function isInsideAny(path: string, dirs: readonly string[], platform: NodeJS.Platform, fs: ExecFs): boolean {
  if (dirs.some((d) => isInside(path, d, platform))) return true;
  if (!fs.realPath) return false;
  const real = realOrAncestor(path, platform, fs);
  if (real === undefined) return false;
  return dirs.some((d) => isInside(real, d, platform) || isInside(real, realOrAncestor(d, platform, fs) ?? d, platform));
}

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
  if (env === null || typeof env !== "object") return "";
  for (const k of Object.keys(env)) {
    if ((platform === "win32" ? k.toUpperCase() : k) === "PATH" && typeof env[k] === "string") return env[k] as string;
  }
  return "";
}

function pathExt(env: Readonly<Record<string, string | undefined>>): string[] {
  let raw = ".COM;.EXE";
  if (env !== null && typeof env === "object") {
    for (const k of Object.keys(env)) if (k.toUpperCase() === "PATHEXT" && typeof env[k] === "string") raw = env[k] as string;
  }
  // CreateProcess runs only real executables; .bat and .cmd are refused and scripts (.vbs, .ps1) cannot be started.
  return raw.split(";").map((e) => e.trim()).filter((e) => /^\.(?:exe|com)$/i.test(e));
}

/**
 * Resolves a bare command name against PATH only. Empty entries, relative entries (including `.`), the current
 * directory and any `excludeDirs` are ignored, and so is any candidate whose real path (symlinks resolved) is inside
 * an `excludeDirs` entry. On win32 PATHEXT applies, limited to `.exe` and `.com`. Returns an absolute path, or undefined.
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
    const excluded = opts.excludeDirs ?? [];
    if (excluded.some((x) => isInside(dir, x, platform))) continue;
    for (const n of names) {
      const candidate = joinPath(dir, n, platform);
      if (fs.isExecutableFile(candidate) && !isInsideAny(candidate, excluded, platform, fs)) return candidate;
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
  if (platform === "win32") {
    if (isBatchName(command0)) return BATCH_HINT;
    // `C:\a.exe:stream` names an alternate data stream; a trailing separator names a directory.
    if (command0.slice(2).includes(":") || /[\\/]$/.test(command0)) return "command[0] must not contain ':' after the drive or end with a path separator";
  }
  return undefined;
}
