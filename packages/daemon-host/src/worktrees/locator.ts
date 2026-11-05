// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Journal } from "@axis/journal";
import type { WorktreeRef } from "@axis/git-ops";
import type { WorktreeLocator } from "../ports/worktree-locator.js";
import { worktreeFailure } from "./errors.js";
import type { RepoFacts } from "./shapes.js";

export interface LocatorDeps {
  readonly journal: Pick<Journal, "getWorkspace">;
  /** The managed worktree root, as configured at startup. */
  readonly worktreeRoot: string;
  readonly platform: NodeJS.Platform;
  /** `resolveRepo` of `@axis/worktrees`: where a path's repository and git directory are. */
  readonly resolveRepo: (p: string) => Promise<RepoFacts>;
}

const key = (p: string, platform: NodeJS.Platform): string => (platform === "win32" ? p.toLowerCase() : p);

/** True when `child` is `parent` or below it (both canonical). */
export function isInside(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const rel = path.relative(key(parent, platform), key(child, platform));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Workspace id to its worktree (DMN-2, GIT-4): the path comes from the journal row the host wrote, never from a
 * request, and is checked against the disk at the moment of use. Every check fails closed with the same
 * `E_NOT_FOUND`, so a caller cannot tell a removed workspace from one whose directory was swapped:
 * the workspace is live and has a recorded path; `realpath` still names the recorded path (a symlink swapped in
 * since is refused); it is inside the real worktree root; it is the root of a linked worktree of its own.
 */
export function createWorktreeLocator(deps: LocatorDeps): WorktreeLocator {
  return {
    async locate(workspaceId: string): Promise<WorktreeRef> {
      const missing = (): Error => worktreeFailure("E_NOT_FOUND");
      const ws = typeof workspaceId === "string" ? deps.journal.getWorkspace(workspaceId) : undefined;
      if (ws === undefined || ws.worktreePath === null || !(ws.state === "READY" || ws.state === "FINALISED" || ws.state === "REMOVING")) {
        throw missing();
      }
      let real: string;
      let root: string;
      try {
        real = await fs.realpath(ws.worktreePath);
        root = await fs.realpath(deps.worktreeRoot);
      } catch {
        throw missing();
      }
      if (key(real, deps.platform) !== key(ws.worktreePath, deps.platform) || real === root || !isInside(real, root, deps.platform)) {
        throw missing();
      }
      let repo: RepoFacts;
      try {
        repo = await deps.resolveRepo(real);
      } catch {
        throw missing();
      }
      if (!repo.linked || repo.workTree === null || key(repo.workTree, deps.platform) !== key(real, deps.platform)) throw missing();
      return Object.freeze({ workTree: real, gitDir: repo.gitDir });
    },
  };
}
