// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { spawn as nodeSpawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { ExecChild, ExecFn, ExecOutcome, ExecRequest } from "../src/index.js";

/**
 * TEST ONLY, POSIX: an `ExecFn` over `node:child_process`. The child leads a new process group (`detached`), so `kill`
 * signals the whole group. stdout keeps at most `maxOutput` bytes, stderr `maxStderr` (default `maxOutput`). `log` records every
 * request. Production uses `createNodeExec` (exec-node.ts); this one has no program check.
 */
export function pipeExec(log: ExecRequest[] = []): ExecFn {
  return (req: ExecRequest): ExecChild => {
    log.push(req);
    const cp = nodeSpawn(req.argv[0] as string, req.argv.slice(1), { cwd: req.cwd, env: { ...req.env }, detached: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const cuts = { out: false, err: false };
    const collect = (s: NodeJS.ReadableStream, cap: number, which: "out" | "err"): Buffer[] => {
      const parts: Buffer[] = [];
      let n = 0;
      s.on("data", (c: Buffer) => {
        if (n + c.length > cap) {
          cuts[which] = true;
          parts.push(c.subarray(0, Math.max(0, cap - n)));
          n = cap;
        } else {
          parts.push(c);
          n += c.length;
        }
      });
      return parts;
    };
    const out = collect(cp.stdout, req.maxOutput, "out");
    const err = collect(cp.stderr, req.maxStderr ?? req.maxOutput, "err");
    cp.stdin.on("error", () => undefined);
    const done = new Promise<ExecOutcome>((resolve, reject) => {
      cp.once("error", reject);
      cp.once("close", (code, signal) => resolve({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err), truncated: cuts.out || cuts.err, stdoutTruncated: cuts.out, stderrTruncated: cuts.err }));
    });
    cp.stdin.end(req.stdin === undefined ? undefined : Buffer.from(req.stdin));
    return {
      done,
      kill: () => {
        try {
          if (cp.pid !== undefined) process.kill(-cp.pid, "SIGKILL");
        } catch {
          /* gone */
        }
      },
    };
  };
}

/** The absolute path of `git` found on PATH, or undefined. Tests skip with a reason when it is missing. */
export function findGit(): string | undefined {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const p = join(dir, process.platform === "win32" ? "git.exe" : "git");
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return undefined;
}
