// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The forge binding's `readOrigin` (ticket PV-D2 slice 2, docs/design/forge-pr-list.md §2 step 1): what `origin` of the project's
// main checkout says, read with the daemon's own pinned git (`daemonGitFor`, the H9 path `compareUrl` uses: no hooks, isolated
// configuration, `--` before the name). The checkout comes from the journal row, never from a request, and is checked on disk at
// the moment of use.
import { daemonGitFor, type GitOpsDeps } from "@axis/git-ops";
import { readRepositoryBinding } from "../projects/binding.js";
import type { OriginRead } from "./service.js";

export interface OriginReaderDeps {
  /** The registered project's recorded path (the journal row), or undefined. */
  readonly projectPath: (projectId: string) => string | undefined;
  /** The daemon's git port (`createGitPort`). */
  readonly git: GitOpsDeps;
  readonly platform: NodeJS.Platform;
  /** This process's uid (`process.getuid()`), for the binding's owner rule; undefined where there is none (refused). */
  readonly uid: number | undefined;
}

/** The longest `origin` URL read; a longer one is no remote Axis uses (the vetting would refuse it anyway). */
export const MAX_ORIGIN_CHARS = 2048;

/**
 * Throws when the checkout is not usable: the service answers `no_remote` for a throw, so a moved, swapped or linked checkout
 * never names a repository. The checkout must pass the project registration's own binding check (`projects/binding.ts`,
 * `readRepositoryBinding`, without git discovery): the recorded path is its own real path, and `.git` in it is a real directory
 * this user owns (not a symlink, not a `gitdir:` file pointing elsewhere, no `commondir`). git then gets that directory as
 * `--git-dir` and the recorded path as `--work-tree` (GIT-4).
 */
export function createOriginReader(deps: OriginReaderDeps): (projectId: string) => Promise<OriginRead> {
  return async (projectId) => {
    const recorded = deps.projectPath(projectId);
    if (recorded === undefined) throw new Error("no project");
    const bound = await readRepositoryBinding(recorded, { platform: deps.platform, uid: deps.uid });
    if (!bound.ok) throw new Error("not a bound repository");
    const git = await daemonGitFor({ workTree: bound.binding.path, gitDir: bound.binding.commonDir }, deps.git);
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
