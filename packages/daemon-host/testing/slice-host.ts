// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The host of the headless slice (plan section 1): the REAL composition root in a child process, on the real `process` (real lock,
// real signals, real exit code), over the Node IPC channel the test supervisor speaks. What is fake is listed in `fake-pty.ts`
// (the pty port and the `pty` git runner) and below (the run snapshotter). No Electron, no UI, no Code OSS.
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
  type ComposeOptions,
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
 * FAKE (replaced by the GIT-SNAP-1 snapshot of `@axis/git-snapshot` or `@axis/worktrees` `gitSnap`, plan question 10): a run is
 * never refused for a changed repository and never reports drift. The slice does not assert drift.
 */
const snapshotter: NonNullable<ComposeOptions["snapshotter"]> = { before: () => Promise.resolve(), after: () => Promise.resolve({ drift: false }) };

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
      snapshotter,
      scanMode: process.env["AXIS_SLICE_SCAN_MODE"] === "warn" ? "warn" : "refuse",
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
