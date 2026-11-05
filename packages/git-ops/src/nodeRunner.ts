// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { spawn } from "node:child_process";
import { GitOpsError, denied } from "./errors.js";
import { isInsideAny, nodeFs } from "@axis/pty-policy";
import { readExcludeDirs } from "./excludeDirs.js";
import { assertGitOutsideWorktree, assertNoEnvOverride, requestDirs, resolveGit, withTrustedPath } from "./gitPath.js";
import type { GitRunRequest, GitRunResult, GitRunner } from "./types.js";

export interface NodeRunnerOptions {
  /** Tests only: allow the "pty" context in this process. The daemon must leave this false. */
  readonly allowPtyContext?: boolean;
  /**
   * Absolute path of the git executable, resolved ONCE by the host at daemon start with `resolveGit` and every registered
   * worktree excluded. Default: resolved on the first request from the environment snapshot with the request's
   * directories (and `excludeDirs()`) excluded. Either way it is cached for the life of the runner and used by absolute
   * path (a bare `git` is never spawned); a path inside the request's directories is refused. When the cached file has
   * gone (a package manager replaced it) it is looked up again through `resolveGit` only, with `excludeDirs()` in force.
   * An injected path with no `excludeDirs` is NOT looked up again: the request fails with `E_UNAVAILABLE`. That state is
   * permanent for this runner: the host must build a NEW runner (there is no setter).
   * With neither `gitPath` nor `excludeDirs` every request is refused (see `allowUnpinnedGit`).
   */
  readonly gitPath?: string;
  /**
   * Every registered worktree and git directory, read on EACH lookup (the list changes). Required for any re-resolve of an
   * injected `gitPath`. It must return a plain `Array` (not a Proxy or subclass, no accessors or holes) of at most 1024
   * absolute, normalised path strings (duplicates by real path are dropped); a throw, a Promise, a string, `undefined`, a
   * relative or empty entry is refused with `E_UNAVAILABLE` (fixed text, nothing of the host's value or message is echoed)
   * and nothing is looked up or spawned. Without a host `gitPath`, a list that covers none of the request's directories
   * (cwd, --work-tree, --git-dir) is refused too, unless `allowUnpinnedGit` is set.
   */
  readonly excludeDirs?: () => readonly string[];
  /**
   * Tests only, and weaker. With neither `gitPath` nor `excludeDirs` the runner refuses every request with
   * `E_UNAVAILABLE` ("host must supply gitPath or excludeDirs"), because it could then pick a git planted in a sibling
   * worktree whose folder is on PATH and cache it for everyone. Setting this to true allows that lookup (only the
   * request's own directories are excluded). A daemon must leave it unset.
   */
  readonly allowUnpinnedGit?: boolean;
  /** The environment git is looked up in. Default: a copy of `process.env` taken when the runner is created. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly maxOutput?: number;
}

// Each git child runs in its own process group (POSIX), so a timeout can kill git's children too. The price: a group
// does not die with the daemon. A normal exit kills every live group below; a crash or SIGKILL of the daemon cannot,
// and leaves an orphaned git (and its children) running until it finishes. That is accepted.
const liveGroups = new Set<number>();
let exitHookInstalled = false;

function killLiveGroups(): void {
  for (const pid of liveGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  liveGroups.clear();
}

/** Runs git with an argv vector and no shell. Refuses the pty context unless explicitly allowed. */
export function createNodeRunner(opts: NodeRunnerOptions = {}): GitRunner {
  const maxOutput = opts.maxOutput ?? 32 * 1024 * 1024;
  let cached: string | undefined = opts.gitPath;
  const injected = opts.gitPath !== undefined;
  const platform = process.platform;
  const lookupEnv = { ...(opts.env ?? process.env) };
  /** The host's list, copied, checked and deduplicated (see readExcludeDirs). Any problem is a closed-set refusal. */
  function hostExcludes(): string[] {
    return opts.excludeDirs === undefined ? [] : readExcludeDirs(opts.excludeDirs, platform);
  }
  /** The real path to spawn. A vanished file is looked up once more, through the one trusted resolver. */
  function pickGit(req: GitRunRequest): string {
    if (opts.gitPath === undefined && opts.excludeDirs === undefined && opts.allowUnpinnedGit !== true) {
      throw new GitOpsError("E_UNAVAILABLE", "host must supply gitPath or excludeDirs");
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (cached === undefined && injected && opts.excludeDirs === undefined) {
        throw new GitOpsError("E_UNAVAILABLE", "the git executable the host gave has gone; the host must resolve it again");
      }
      if (cached === undefined) {
        const listed = hostExcludes();
        const mine = requestDirs(req, platform);
        // Without a host gitPath the list is the only protection against a sibling's git: it must cover this request.
        if (opts.gitPath === undefined && opts.allowUnpinnedGit !== true && !mine.some((d) => isInsideAny(d, listed, platform, nodeFs))) {
          throw new GitOpsError("E_UNAVAILABLE", "the host's excludeDirs does not cover this request's directories");
        }
        cached = resolveGit(lookupEnv, platform, [...listed, ...mine]);
      }
      if (cached === undefined) throw new GitOpsError("E_UNAVAILABLE", "no git executable was found in a trusted PATH entry");
      assertGitOutsideWorktree(cached, req, platform);
      const real = nodeFs.realPath?.(cached);
      if (real !== undefined) {
        assertGitOutsideWorktree(real, req, platform);
        return real;
      }
      cached = undefined; // gone: the next round looks again through resolveGit, the only trusted lookup
    }
    throw new GitOpsError("E_UNAVAILABLE", "the git executable could not be found");
  }
  return {
    run(req: GitRunRequest): Promise<GitRunResult> {
      if (req.context === "pty" && opts.allowPtyContext !== true) {
        return Promise.reject(denied("the daemon process must not run pty-context git"));
      }
      let gitPath: string;
      try {
        assertNoEnvOverride(req.env);
        gitPath = pickGit(req);
      } catch (e) {
        return Promise.reject(e);
      }
      return new Promise((resolve, reject) => {
        // Its own process group on POSIX, so a timeout can kill git's children too (filters, submodule diffs, ssh).
        const group = process.platform !== "win32";
        const child = spawn(gitPath, [...req.argv], { cwd: req.cwd, env: withTrustedPath(req.env, req, platform), shell: false, detached: group, stdio: ["pipe", "pipe", "pipe"] });
        if (group && child.pid !== undefined) {
          liveGroups.add(child.pid);
          if (!exitHookInstalled) {
            exitHookInstalled = true;
            process.on("exit", killLiveGroups);
          }
        }
        const pid = child.pid;
        const done = (): void => {
          if (pid !== undefined) liveGroups.delete(pid);
        };
        let out = "";
        let err = "";
        const timer = setTimeout(() => {
          try {
            if (group && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }, opts.timeoutMs ?? 120_000);
        let truncated = false;
        child.stdout.setEncoding(req.raw === true ? "latin1" : "utf8").on("data", (d: string) => {
          const room = Math.max(0, maxOutput - out.length);
          if (d.length > room) truncated = true;
          out += d.slice(0, room);
        });
        child.stderr.setEncoding("utf8").on("data", (d: string) => {
          if (err.length < 64 * 1024) err += d;
        });
        child.on("error", (e) => {
          done();
          clearTimeout(timer);
          reject(e);
        });
        child.on("close", (code) => {
          done();
          clearTimeout(timer);
          resolve({ code: code ?? -1, stdout: out, stderr: err, ...(truncated ? { truncated: true } : {}), ...(req.raw === true ? { raw: true } : {}) });
        });
        child.stdin.on("error", () => undefined);
        child.stdin.end(req.stdin ?? "");
      });
    },
  };
}
