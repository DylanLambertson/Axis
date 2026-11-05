// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { spawn } from "node:child_process";
import { createNodeRunner, type GitRunner } from "@axis/git-ops";
import type { PtyExit, PtyHandle, PtyPort, PtySpawn } from "../src/index.js";

/**
 * TEST ONLY: the fakes the headless slice runs on until the Axis pty process exists (ticket B9).
 *
 * `LocalPty` is the fake `PtyPort`: it runs the argv the run supervisor built as a plain child process (no terminal, no process
 * group). `groupAlive()` therefore means "the child has not exited", which is NOT the POSIX or Windows contract of plan
 * question 18 (a group that outlives its leader); the real pty process replaces it with `kill(-pgid, 0)` or a job object and
 * carries the `sh -c 'sleep 30 & exit 0'` acceptance test. Its stdin is a pipe, so a child that waits on it ends when this
 * process dies (the SIGKILL step leaves nothing behind).
 *
 * `localPtyGitRunner` is the fake `pty` git context: one local node runner, pinned to the host's git path, serving the
 * `pty` context in this process. The real one runs in the pty process, where credentials and signing live (B9).
 */
export class LocalPty implements PtyPort {
  readonly spawned: PtySpawn[] = [];

  spawn(spec: PtySpawn): Promise<PtyHandle> {
    this.spawned.push(spec);
    return new Promise<PtyHandle>((resolve, reject) => {
      const child = spawn(spec.argv[0] as string, spec.argv.slice(1), { cwd: spec.cwd, env: { ...spec.env }, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
      let exit: PtyExit | undefined;
      const listeners = new Set<(e: PtyExit) => void>();
      child.stdin.on("error", () => undefined);
      child.once("error", reject); // before the process exists: the supervisor refuses the launch
      child.once("exit", (exitCode, signal) => {
        exit = { exitCode, signal };
        for (const l of [...listeners]) l(exit);
      });
      child.once("spawn", () => {
        child.removeListener("error", reject);
        child.on("error", () => undefined);
        resolve({
          write: () => undefined,
          resize: () => undefined,
          kill: (signal) => void child.kill(signal),
          groupAlive: () => exit === undefined,
          onData: () => ({ dispose: () => undefined }),
          onExit(listener) {
            if (exit !== undefined) queueMicrotask(() => listener(exit as PtyExit));
            else listeners.add(listener);
            return { dispose: () => void listeners.delete(listener) };
          },
        });
      });
    });
  }
}

export function localPtyGitRunner(gitPath: string, env: Readonly<Record<string, string | undefined>>): GitRunner {
  return createNodeRunner({ allowPtyContext: true, gitPath, excludeDirs: () => [], env });
}
