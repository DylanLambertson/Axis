// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// TEST ONLY: the real pty service (`@axis/pty-process`) with a POSIX exec function, reached through the real host port over an
// in-memory control channel, and `createPtyGitRunner` over that port.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitRunner } from "@axis/git-ops";
import { createPtyProcessPort, createPtyService, type Channel, type ExecFn, type ExecOutcome, type ExecRequest } from "@axis/pty-process";
import { createPtyGitRunner } from "../src/bindings/pty-git.js";

/** One end of an in-memory channel pair that delivers in a later microtask, like a MessagePort. */
class End {
  peer: End | undefined;
  private open = true;
  private readonly ml = new Set<(m: unknown) => void>();
  private readonly cl = new Set<() => void>();
  readonly channel: Channel = {
    send: (m) => {
      if (!this.open) throw new Error("closed");
      queueMicrotask(() => this.peer?.receive(m));
    },
    onMessage: (l) => (this.ml.add(l), { dispose: () => void this.ml.delete(l) }),
    onClose: (l) => (this.cl.add(l), { dispose: () => void this.cl.delete(l) }),
    close: () => {
      this.shut();
      queueMicrotask(() => this.peer?.shut());
    },
  };
  receive(m: unknown): void {
    if (this.open) for (const l of [...this.ml]) l(m);
  }
  shut(): void {
    if (!this.open) return;
    this.open = false;
    for (const l of [...this.cl]) l();
  }
}

function channelPair(): { a: Channel; b: Channel } {
  const x = new End();
  const y = new End();
  x.peer = y;
  y.peer = x;
  return { a: x.channel, b: y.channel };
}

/** POSIX: each command leads its own process group; each stream keeps at most `maxOutput` bytes. */
function pipeExec(log: ExecRequest[]): ExecFn {
  return (req) => {
    log.push(req);
    const cp = spawn(req.argv[0] as string, req.argv.slice(1), { cwd: req.cwd, env: { ...req.env }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let truncated = false;
    const collect = (s: NodeJS.ReadableStream): Buffer[] => {
      const parts: Buffer[] = [];
      let n = 0;
      s.on("data", (c: Buffer) => {
        const room = Math.max(0, req.maxOutput - n);
        if (c.length > room) truncated = true;
        parts.push(c.subarray(0, room));
        n += Math.min(room, c.length);
      });
      return parts;
    };
    const out = collect(cp.stdout);
    const err = collect(cp.stderr);
    cp.stdin.on("error", () => undefined);
    const done = new Promise<ExecOutcome>((resolve, reject) => {
      cp.once("error", reject);
      cp.once("close", (code, signal) => resolve({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err), truncated }));
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

export interface PtyProcessRig {
  /** `createPtyGitRunner` over the real port. */
  readonly runner: GitRunner;
  /** Every command the pty service started (the version probe and filter reads included). */
  readonly execs: ExecRequest[];
  /** Closes the control channel: the pty process is gone. */
  close(): void;
  cleanup(): void;
}

export function ptyProcessRig(gitPath: string, baseEnv: Record<string, string>): PtyProcessRig {
  const scratchParent = realpathSync(mkdtempSync(join(tmpdir(), "axis-ptygr-")));
  mkdirSync(join(scratchParent, "s"), { mode: 0o700 });
  const execs: ExecRequest[] = [];
  const service = createPtyService({
    spawn: () => {
      throw new Error("no terminals in this rig");
    },
    git: { exec: pipeExec(execs), gitPath, hooksOff: "/dev/null", scratchParent: join(scratchParent, "s"), baseEnv },
  });
  const pair = channelPair();
  service.serveControl(pair.b);
  const port = createPtyProcessPort({ channel: pair.a });
  return {
    runner: createPtyGitRunner(port, { gitPath, platform: process.platform, hooksOffPath: "/dev/null" }),
    execs,
    close: () => pair.b.close(),
    cleanup() {
      port.dispose();
      service.dispose();
      rmSync(scratchParent, { recursive: true, force: true });
    },
  };
}
