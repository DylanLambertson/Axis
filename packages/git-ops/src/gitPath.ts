// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// CLI-1/CFG-1: the git executable is found by @axis/pty-policy's resolver (one rule for the whole product), outside every
// worktree, and spawned by absolute path. This file only adds the per-request containment check and the child's PATH.
import { delimiterOf, isInsideAny, isPlainAbsolute, isInside, nodeFs, resolveExecutable } from "@axis/pty-policy";
import { denied } from "./errors.js";
import type { GitRunRequest } from "./types.js";

type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * The host calls this ONCE at daemon start with the daemon's own environment and EVERY registered worktree (and git
 * directory) in `excludeDirs`, so a git planted in a sibling worktree whose folder is on PATH is never chosen. Empty and
 * relative PATH entries are ignored. On win32 UNC, device, root-relative and quoted entries are refused too (a network
 * share would run code from elsewhere and leak credentials), and only `.exe`/`.com` count. Returns an absolute path.
 */
export function resolveGit(env: EnvLike, platform: NodeJS.Platform, excludeDirs: readonly string[] = []): string | undefined {
  return resolveExecutable("git", env, platform, nodeFs, { excludeDirs });
}

/** The directories a request works in: cwd, `--work-tree` and `--git-dir`. */
export function requestDirs(req: GitRunRequest): string[] {
  const out = [req.cwd];
  for (const a of req.argv) {
    if (a.startsWith("--work-tree=")) out.push(a.slice(12));
    else if (a.startsWith("--git-dir=")) out.push(a.slice(10));
  }
  return out.filter((d) => d !== "");
}

/**
 * Refuses a git executable that is not absolute or lies in the request's directories, by spelling or by real path
 * (symlinks resolved). `<worktree>/..bin/git` is inside: containment is judged by path component, not by a `..` prefix.
 */
export function assertGitOutsideWorktree(gitPath: string, req: GitRunRequest, platform: NodeJS.Platform): void {
  if (!isPlainAbsolute(gitPath, platform) || isInsideAny(gitPath, requestDirs(req), platform, nodeFs)) {
    throw denied("the git executable must be an absolute path outside the worktree");
  }
}

/**
 * The request's environment with a PATH that holds only plain absolute entries outside the request's directories
 * (git's own children - helpers, hooks, external commands - resolve through it).
 */
export function withTrustedPath(env: Record<string, string>, req: GitRunRequest, platform: NodeJS.Platform): Record<string, string> {
  const out = { ...env };
  const dirs = requestDirs(req);
  for (const k of Object.keys(out)) {
    if (k !== "PATH" && !(platform === "win32" && k.toUpperCase() === "PATH")) continue;
    out[k] = (out[k] as string)
      .split(delimiterOf(platform))
      .filter((d) => isPlainAbsolute(d, platform) && !dirs.some((x) => isInside(d, x, platform)))
      .join(delimiterOf(platform));
  }
  return out;
}
