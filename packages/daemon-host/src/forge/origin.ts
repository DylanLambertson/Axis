// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The forge binding's `readOrigin` (ticket PV-D2 slice 2, docs/design/forge-pr-list.md §2 step 1): what `origin` of the project's
// main checkout says, read with the daemon's own pinned git (`daemonGitFor`, the H9 path `compareUrl` uses: no hooks, isolated
// configuration, `--` before the name). The checkout comes from the journal row, never from a request, and is checked on disk at
// the moment of use.
import { realpath } from "node:fs/promises";
import { daemonGitFor, type GitOpsDeps } from "@axis/git-ops";
import type { RepoFacts } from "../worktrees/shapes.js";
import type { OriginRead } from "./service.js";

export interface OriginReaderDeps {
  /** The registered project's recorded path (the journal row), or undefined. */
  readonly projectPath: (projectId: string) => string | undefined;
  /** `resolveRepo` of `@axis/worktrees` (through the worktrees binding). */
  readonly resolveRepo: (p: string) => Promise<RepoFacts>;
  /** The daemon's git port (`createGitPort`). */
  readonly git: GitOpsDeps;
  readonly platform: NodeJS.Platform;
}

/** The longest `origin` URL read; a longer one is no remote Axis uses (the vetting would refuse it anyway). */
export const MAX_ORIGIN_CHARS = 2048;

const key = (p: string, platform: NodeJS.Platform): string => (platform === "win32" ? p.toLowerCase() : p);

/**
 * Throws when the checkout is not usable: the service answers `no_remote` for a throw, so a moved, swapped or linked checkout
 * never names a repository. The checkout must be the recorded path itself (no symlink swapped in), the root of a main working
 * tree (`.git` found in that directory, not above it, and not a linked worktree).
 */
export function createOriginReader(deps: OriginReaderDeps): (projectId: string) => Promise<OriginRead> {
  return async (projectId) => {
    const recorded = deps.projectPath(projectId);
    if (recorded === undefined) throw new Error("no project");
    const real = await realpath(recorded);
    if (key(real, deps.platform) !== key(recorded, deps.platform)) throw new Error("moved");
    const repo = await deps.resolveRepo(real);
    if (repo.linked || repo.workTree === null || key(repo.workTree, deps.platform) !== key(real, deps.platform)) throw new Error("not a main checkout");
    const git = await daemonGitFor({ workTree: real, gitDir: repo.gitDir }, deps.git);
    const out = await git(["remote", "get-url", "--", "origin"]);
    if (out.code !== 0) return { kind: "none" };
    const url = out.stdout.trim();
    if (url === "") return { kind: "none" };
    // Never cut to fit (a cut URL could name another repository): an over-long one is refused here. Several lines are handed on
    // as is and refused by the vetting (`remote_invalid`).
    if (url.length > MAX_ORIGIN_CHARS) throw new Error("origin too long");
    return { kind: "url", url };
  };
}
