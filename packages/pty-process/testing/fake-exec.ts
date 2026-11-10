// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyService, type ExecFn, type ExecOutcome, type ExecRequest, type PtyService } from "../src/index.js";
import { channelPair, ManualClock, until, type ChannelPair } from "./helpers.js";

export const FAKE_GIT = "/opt/fake-git/bin/git";

/** TEST ONLY: a scripted exec function. `git version` answers `version`; everything else `answer(req)` (default: exit 0, no output). */
export function fakeExec(opts: { version?: string; filters?: string; filterGate?: Promise<void>; answer?: (req: ExecRequest) => ExecOutcome | "hang" } = {}): { exec: ExecFn; log: ExecRequest[]; killed: number } {
  const state = { log: [] as ExecRequest[], killed: 0, exec: undefined as unknown as ExecFn };
  state.exec = (req) => {
    if (req.argv[1] === "version") return { done: Promise.resolve(out(`git version ${opts.version ?? "2.53.0"}\n`)), kill: () => undefined };
    // The service's own filter-driver read before each call: none configured unless `filters` says so.
    if (req.argv.includes("--get-regexp")) {
      const answer = out(opts.filters ?? "", opts.filters === undefined ? 1 : 0);
      return { done: (opts.filterGate ?? Promise.resolve()).then(() => answer), kill: () => undefined };
    }
    state.log.push(req);
    const a = opts.answer?.(req) ?? out("");
    if (a === "hang") return { done: new Promise<ExecOutcome>(() => undefined), kill: () => void state.killed++ };
    return { done: Promise.resolve(a), kill: () => void state.killed++ };
  };
  return state;
}

export const out = (stdout: string | Uint8Array, code = 0): ExecOutcome => ({ code, signal: null, stdout: typeof stdout === "string" ? Buffer.from(stdout) : stdout, stderr: new Uint8Array(), truncated: false });

/** TEST ONLY: a pty service with a fake exec function on a manual clock. */
export function fakeRig(exec: ExecFn, maxExecs?: number): { service: PtyService; pair: ChannelPair; clock: ManualClock; scratchParent: string; replies: Array<Record<string, unknown>>; send(m: Record<string, unknown>): Promise<Record<string, unknown>>; cleanup(): void } {
  const scratchParent = realpathSync(mkdtempSync(join(tmpdir(), "axis-pty-fake-")));
  const clock = new ManualClock();
  const pair = channelPair();
  const service = createPtyService({
    spawn: () => {
      throw new Error("no spawn in this rig");
    },
    clock,
    git: { exec, gitPath: FAKE_GIT, hooksOff: "/dev/null", scratchParent, baseEnv: { PATH: "/usr/bin", GIT_ALLOW_PROTOCOL: "file", HOME: "/home/u" }, ...(maxExecs === undefined ? {} : { maxExecs }) },
  });
  service.serveControl(pair.b);
  const replies: Array<Record<string, unknown>> = [];
  pair.a.onMessage((m) => void replies.push(m as Record<string, unknown>));
  return {
    service, pair, clock, scratchParent, replies,
    async send(m) {
      pair.a.send(m);
      await until(() => replies.some((r) => r["req"] === m["req"]));
      return replies.find((r) => r["req"] === m["req"]) as Record<string, unknown>;
    },
    cleanup() {
      service.dispose();
      rmSync(scratchParent, { recursive: true, force: true });
    },
  };
}
