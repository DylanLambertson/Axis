// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { RandomSource } from "../ports/random.js";

/**
 * The slug of a new workspace: the user's name reduced to `a-z`, `0-9` and `-`, then a short random suffix so two
 * workspaces with the same name never share a branch. It is what `axis/<slug>` (the branch) and the worktree directory
 * are named after, and it matches the package's `SLUG_PATTERN`.
 */
export function workspaceSlug(name: string, random: RandomSource): string {
  const base =
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "workspace";
  const suffix = Array.from(random.bytes(3), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${base}-${suffix}`;
}
