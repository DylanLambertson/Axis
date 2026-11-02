// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { isInside, isPlainAbsolute } from "./paths.js";

export interface GitConfigFileWarning {
  readonly name: "GIT_CONFIG_GLOBAL" | "GIT_CONFIG_SYSTEM";
  readonly value: string;
  readonly worktreeRoot: string;
}

/**
 * GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM are the user's own environment and are kept in CLI runs. When either
 * resolves inside a managed worktree an agent can edit it, so Axis warns. A relative value is resolved against the
 * run's cwd, which is a worktree, so it always warns.
 */
export function gitConfigFileWarnings(
  env: Readonly<Record<string, string | undefined>>,
  worktreeRoots: readonly string[],
  platform: NodeJS.Platform = process.platform,
): GitConfigFileWarning[] {
  const out: GitConfigFileWarning[] = [];
  for (const k of Object.keys(env)) {
    const name = k.toUpperCase();
    const value = env[k];
    if ((name !== "GIT_CONFIG_GLOBAL" && name !== "GIT_CONFIG_SYSTEM") || typeof value !== "string" || value.length === 0) continue;
    const roots = isPlainAbsolute(value, platform) ? worktreeRoots.filter((r) => isInside(value, r, platform)) : worktreeRoots.slice(0, 1);
    for (const worktreeRoot of roots) out.push({ name, value, worktreeRoot });
  }
  return out;
}
