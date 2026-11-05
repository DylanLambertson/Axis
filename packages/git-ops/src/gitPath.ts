// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// CLI-1/CFG-1: the git executable is found outside the worktree, once, and spawned by absolute path.
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative } from "node:path";
import { denied } from "./errors.js";
import type { GitRunRequest } from "./types.js";

/** A PATH without empty and relative entries: both mean "the current directory", which is the worktree. */
export function trustedPath(value: string | undefined, sep: string = delimiter): string {
  return (value ?? "").split(sep).filter((d) => d !== "" && isAbsolute(d)).join(sep);
}

/** The first real, executable `git` in the trusted entries of `pathEnv`, as a real (symlink-free) absolute path. */
export function resolveGit(pathEnv: string | undefined, platform: NodeJS.Platform = process.platform): string | undefined {
  const names = platform === "win32" ? ["git.exe"] : ["git"];
  for (const dir of trustedPath(pathEnv).split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (platform !== "win32") accessSync(candidate, constants.X_OK);
        return realpathSync(candidate);
      } catch {
        /* not here */
      }
    }
  }
  return undefined;
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function inside(dir: string, file: string): boolean {
  const r = relative(real(dir), file);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/** Refuses a git executable that lies in the request's working directory, work tree or git directory. */
export function assertGitOutsideWorktree(gitPath: string, req: GitRunRequest): void {
  const dirs = [req.cwd, ...req.argv.flatMap((a) => (a.startsWith("--work-tree=") ? [a.slice(12)] : a.startsWith("--git-dir=") ? [a.slice(10)] : []))];
  if (!isAbsolute(gitPath) || dirs.some((d) => d !== "" && inside(d, gitPath))) {
    throw denied("the git executable must be an absolute path outside the worktree");
  }
}

/** The request's environment with a PATH that holds no empty or relative entries (git's own children resolve through it). */
export function withTrustedPath(env: Record<string, string>, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const out = { ...env };
  for (const k of Object.keys(out)) {
    if (k === "PATH" || (platform === "win32" && k.toUpperCase() === "PATH")) out[k] = trustedPath(out[k]);
  }
  return out;
}
