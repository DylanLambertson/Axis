// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { spawn } from "node:child_process";
import { GitOpsError, denied } from "./errors.js";
import { nodeFs } from "@axis/pty-policy";
import { assertGitOutsideWorktree, requestDirs, resolveGit, withTrustedPath } from "./gitPath.js";
import type { GitRunRequest, GitRunResult, GitRunner } from "./types.js";

export interface NodeRunnerOptions {
  /** Tests only: allow the "pty" context in this process. The daemon must leave this false. */
  readonly allowPtyContext?: boolean;
  /**
   * Absolute path of the git executable, resolved ONCE by the host at daemon start with `resolveGit` and every registered
   * worktree excluded. Default: resolved on the first request from the daemon's own PATH with only that request's
   * directories excluded. Either way it is cached for the life of the runner and used by absolute path (a bare `git` is
   * never spawned); a path inside the request's directories is refused. It is looked up again, through `resolveGit`
   * only, when the cached file has gone (a package manager replaced it).
   */
  readonly gitPath?: string;
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
  const platform = process.platform;
  /** The real path to spawn. A vanished file is looked up once more, through the one trusted resolver. */
  function pickGit(req: GitRunRequest): string {
    for (let attempt = 0; attempt < 2; attempt++) {
      cached ??= resolveGit(process.env, platform, requestDirs(req));
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
