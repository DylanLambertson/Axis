// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { isAbsolute } from "node:path";
import { AxisError } from "@axis/audit";
import { resolveGit } from "@axis/git-ops";

export interface GitResolveInput {
  /** A copy of the environment taken by the caller; this module never reads `process.env`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  /** The managed worktree root, the data directory, the process working directory and every registered repository. */
  readonly excludeDirs: readonly string[];
}

/**
 * Design section 3, step 5a: find the absolute `git` path ONCE, with every directory that holds user-controlled files
 * excluded, so a git planted in a worktree (or in the current directory) on PATH is never chosen. The result is passed
 * unchanged to `@axis/git-ops` (`createNodeRunner({ gitPath })`) and to `@axis/worktrees` (`createExecGitRunner({ gitPath })`,
 * which uses an absolute path as given), so no component looks again. This is the host side of FU-GIT-RESOLVE.
 * Not found is `E_UNAVAILABLE` with a fixed message: nothing falls back to a bare `git`.
 */
export function resolveGitOnce(input: GitResolveInput): string {
  const found = resolveGit(input.env, input.platform, input.excludeDirs);
  if (found === undefined || !isAbsolute(found)) {
    throw new AxisError("E_UNAVAILABLE", "git was not found outside the managed directories", { reason: "git_not_found" });
  }
  return found;
}
