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
} from "../src/index.js";
import { LocalPty, localPtyGitRunner } from "./fake-pty.js";
import { endpointSlicePty } from "./slice-pty.js";
import { sliceComposer } from "./slice-composer.js";
import { sliceIntegrations } from "./slice-integrations.js";
import { SLICE_SNAPSHOT_TAKE_MS, sliceSnapshotter } from "./slice-snapshotter.js";

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

/**
 * TEST ONLY (`AXIS_SLICE_FINAL_WAIT_MS=<n>`): how long the final anchor waits for its acknowledgement (the finalize bound moves with
 * it), so a test that holds the acknowledgement decides by condition when it arrives and a loaded host cannot time it out first.
 */
const endpointRuntime = process.env["AXIS_SLICE_ENDPOINT_RUNTIME"];
const finalWaitMs = /^[1-9][0-9]{0,8}$/.test(process.env["AXIS_SLICE_FINAL_WAIT_MS"] ?? "") ? Number(process.env["AXIS_SLICE_FINAL_WAIT_MS"]) : undefined;

client.onInit((raw) => {
  const redactor = new Redactor();
  const fail = (e: unknown): void => {
    // TEST ONLY: one diagnostic line, so a slice test can say why its host did not start.
    process.stderr.write(`slice.start_failed ${String((e as { code?: unknown }).code ?? "")} ${String((e as { detail?: unknown }).detail === undefined ? "" : JSON.stringify((e as { detail?: unknown }).detail))} ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = exitCodeForStartupError(e);
    release();
    process.exit(process.exitCode);
  };
  try {
    const parsed = parseHostConfig(raw, redactor);
    // The supervisor's own bound on the whole snapshot follows the take bound (a hang guard on a loaded host; a take ends when git does).
    const config = { ...parsed, limits: Object.freeze({ ...parsed.limits, runSnapshotTimeoutMs: SLICE_SNAPSHOT_TAKE_MS * 2 }) };
    const logger = createLogger({ redactor, clock, level: config.logLevel, sink: { write: (line) => void process.stderr.write(`${line}\n`) } });
    const env = { ...process.env };
    const gitPath = resolveGit(env, process.platform);
    if (gitPath === undefined) throw new Error("git is not installed");
    const composed = composeDaemonHost({
      config,
      control: client,
      mux,
      ports: { clock, storage: createNodeStorage(), redactor, logger, env, cwd: process.cwd() },
      // TEST ONLY (`AXIS_SLICE_ENDPOINT_RUNTIME=<dir>`): a pty port that can host CLI messaging endpoints (`slice-pty.ts`).
      pty: endpointRuntime === undefined ? new LocalPty() : endpointSlicePty(endpointRuntime),
      ptyGitRunner: localPtyGitRunner(gitPath, env),
      snapshotter: sliceSnapshotter(), // the real GIT-SNAP-1 snapshot (ticket H13), not a fake, with a hang-guard bound for a loaded host
      ...(finalWaitMs === undefined ? {} : { finalAnchorWaitMs: finalWaitMs, finalizeTimeoutMs: finalWaitMs + 60_000 }),
      scanMode: process.env["AXIS_SLICE_SCAN_MODE"] === "warn" ? "warn" : "refuse",
      // By default a composer run's first turn writes the root Makefile (a protected path: it waits for the user's approval) and
      // later turns answer text; `AXIS_SLICE_COMPOSER` names a file of scripted scenarios and an Anthropic connection (C7).
      composer: sliceComposer(process.env),
      // `AXIS_SLICE_INTEGRATIONS` names the integrations' test seam and canary backend (slice-integrations.ts); unset, none.
      ...((): Pick<Parameters<typeof composeDaemonHost>[0], "integrations"> => {
        const integrations = sliceIntegrations(process.env);
        return integrations === undefined ? {} : { integrations };
      })(),
      // `AXIS_SLICE_SECRET_BROKER=<connection id>` turns the secret broker wiring on (compose-secrets.ts; PV-N0c-1); unset, off,
      // as the daemon entry leaves it.
      ...(/^[a-z0-9][a-z0-9._-]{0,63}$/.test(process.env["AXIS_SLICE_SECRET_BROKER"] ?? "") ? { secretBroker: { connectionId: process.env["AXIS_SLICE_SECRET_BROKER"] as string } } : {}),
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
