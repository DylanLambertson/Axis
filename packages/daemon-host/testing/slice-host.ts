// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The host of the headless slice (plan section 1): the REAL composition root in a child process, on the real `process` (real lock,
// real signals, real exit code), over the Node IPC channel the test supervisor speaks. What is fake is listed in `fake-pty.ts`
// (the pty port and the `pty` git runner); the run snapshotter is the real `@axis/git-snapshot` one. No Electron, no UI, no Code OSS.
import { existsSync } from "node:fs";
import { Redactor } from "@axis/audit";
import { resolveGit } from "@axis/git-ops";
import {
  ChannelMux,
  ControlClient,
  adaptNodeIpc,
  composeDaemonHost,
  createLogger,
  createNodeStorage,
  exitCodeForStartupError,
  parseHostConfig,
  ProjectMutex,
  type Clock,
  gitSnapshotRunSnapshotter,
} from "../src/index.js";
import { LocalPty, localPtyGitRunner } from "./fake-pty.js";

/**
 * TEST ONLY (`AXIS_SLICE_MUTEX_PROBE=1`): every `ProjectMutex.run` reports which instance it ran on, so the slice can assert that
 * the worktrees, git and runs handlers share ONE mutex (plan question 19). It changes nothing else.
 */
if (process.env["AXIS_SLICE_MUTEX_PROBE"] === "1") {
  const ids = new WeakMap<object, number>();
  let next = 0;
  const original = ProjectMutex.prototype.run;
  ProjectMutex.prototype.run = function probed(this: ProjectMutex, ...args: Parameters<typeof original>) {
    if (!ids.has(this)) ids.set(this, ++next);
    process.stderr.write(`slice.mutex ${ids.get(this)}\n`);
    return original.apply(this, args);
  } as typeof original;
}

const clock: Clock = { now: () => Date.now(), monotonic: () => performance.now() };
const channel = adaptNodeIpc(process);
const mux = new ChannelMux(channel);
const client = new ControlClient({ mux });
const release = (): void => {
  client.dispose();
  mux.dispose();
  channel.dispose();
};

/**
 * TEST ONLY (`AXIS_SLICE_BREAK_PUT=<file>`): while that file exists, `anchor.put` cannot be sent (as on a closed channel), so the
 * final anchor of a shutdown cannot go out. It cannot be reached from `HostConfig`.
 */
const breakPut = process.env["AXIS_SLICE_BREAK_PUT"];
if (breakPut !== undefined) {
  const realPut = client.anchorPut.bind(client);
  client.anchorPut = (head) => (existsSync(breakPut) ? ((): never => { throw new Error("channel closed"); })() : realPut(head));
}

client.onInit((raw) => {
  const redactor = new Redactor();
  const fail = (e: unknown): void => {
    process.exitCode = exitCodeForStartupError(e);
    release();
    process.exit(process.exitCode);
  };
  try {
    const config = parseHostConfig(raw, redactor);
    const logger = createLogger({ redactor, clock, level: config.logLevel, sink: { write: (line) => void process.stderr.write(`${line}\n`) } });
    const env = { ...process.env };
    const gitPath = resolveGit(env, process.platform);
    if (gitPath === undefined) throw new Error("git is not installed");
    const composed = composeDaemonHost({
      config,
      control: client,
      mux,
      ports: { clock, storage: createNodeStorage(), redactor, logger, env, cwd: process.cwd() },
      pty: new LocalPty(),
      ptyGitRunner: localPtyGitRunner(gitPath, env),
      snapshotter: gitSnapshotRunSnapshotter, // the real GIT-SNAP-1 snapshot (ticket H13), not a fake
      scanMode: process.env["AXIS_SLICE_SCAN_MODE"] === "warn" ? "warn" : "refuse",
      // A composer run's first turn writes the root Makefile (a protected path: it waits for the user's approval); later turns answer text.
      composer: { mock: { respond: (req) => (req.messages.length === 1 ? { kind: "tool_use", name: "write_file", input: { path: "Makefile", content: "all:\n" } } : { kind: "text", text: "done" }) } },
      process,
      exit: (code, info) => {
        process.exitCode = code;
        release(); // the channel no longer holds the event loop: a released host ends by draining
        if (!info.released) {
          process.stderr.write("slice.forced_exit\n"); // the test asserts a graceful shutdown ends by draining, not by this
          process.exit(code);
        }
      },
    });
    composed.start().catch(fail);
  } catch (e) {
    fail(e);
  }
});
