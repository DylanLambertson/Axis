// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { spawn } from "node:child_process";
import { denied } from "./errors.js";
import type { GitRunRequest, GitRunResult, GitRunner } from "./types.js";

export interface NodeRunnerOptions {
  /** Tests only: allow the "pty" context in this process. The daemon must leave this false. */
  readonly allowPtyContext?: boolean;
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
  return {
    run(req: GitRunRequest): Promise<GitRunResult> {
      if (req.context === "pty" && opts.allowPtyContext !== true) {
        return Promise.reject(denied("the daemon process must not run pty-context git"));
      }
      return new Promise((resolve, reject) => {
        // Its own process group on POSIX, so a timeout can kill git's children too (filters, submodule diffs, ssh).
        const group = process.platform !== "win32";
        const child = spawn("git", [...req.argv], { cwd: req.cwd, env: req.env, shell: false, detached: group, stdio: ["pipe", "pipe", "pipe"] });
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
          resolve({ code: code ?? -1, stdout: out, stderr: err, ...(truncated ? { truncated: true } : {}) });
        });
        child.stdin.on("error", () => undefined);
        child.stdin.end(req.stdin ?? "");
      });
    },
  };
}
