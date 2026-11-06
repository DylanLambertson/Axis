// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError, Redactor } from "@axis/audit";
import type { GitRunner } from "@axis/git-ops";
import { gitSnapshotRunSnapshotter } from "./bindings/snapshot.js";
import { composeDaemonHost } from "./compose.js";
import { parseHostConfig } from "./config.js";
import { ControlClient } from "./control/client.js";
import type { ListenerTarget } from "./disposables.js";
import { EXIT, exitCodeForStartupError, type ExitCode } from "./exit-codes.js";
import { createLogger } from "./log/logger.js";
import { summarizeError } from "./log/summarize-error.js";
import type { Clock } from "./ports/clock.js";
import type { PtyPort } from "./ports/pty.js";
import type { StoragePort } from "./ports/storage.js";
import { createNodeStorage } from "./storage/node-storage.js";
import { adaptParentPort, type ParentPortLike } from "./transport/electron-parent-port.js";
import { ChannelMux } from "./transport/mux.js";

/**
 * The utility process entry logic (ticket X1, design `docs/design/daemon-host-entry.md`). The overlay file
 * `vs/axis/daemon/node/axisDaemonMain.ts` only hands this function the real `process`, `process.parentPort` and the environment
 * main gave the process; everything that can be tested without Electron is here.
 *
 * What it does, in order, and what fails closed (every refusal is exit code 78 and a `fatal` message of closed codes, before any
 * data directory, lock, file or listener exists):
 * 1. not a utility process (no parent port), a debugging or inspector flag in `execArgv`, or `NODE_OPTIONS` in the environment: refused;
 * 2. the parent port is adapted BEFORE anything awaits, so the one `init` message cannot be lost;
 * 3. exactly one `init` within `initTimeoutMs` (design 3, step 2); none in time: refused;
 * 4. `HostConfig` parsed strictly; a `platform` that is not the process's own: refused;
 * 5. `composeDaemonHost` with the real clock, the real storage, the one environment copy and the real `process` for signals. The
 *    run snapshotter is always the real one (`gitSnapshotRunSnapshotter`, `@axis/git-snapshot`, ticket H13). The pty port and the
 *    pty git runner are NOT defaults here: they come from `deps.ports` and the production entry passes none, so `composeDaemonHost`
 *    refuses (`pty_required`, exit 78) until the Axis pty process (B9) exists. No fake is imported by this file, by the overlay
 *    entry or by anything in `src`.
 *
 * It opens no socket and no port; `connect` messages arrive only on the parent port, which only the parent can write.
 */

/** A `process` the entry may end: the listener target the lifecycle needs plus the exit code and `exit`. */
export interface EntryProcess extends ListenerTarget {
  exitCode?: number | string | null | undefined;
  exit(code?: number): unknown;
}

/** The two ports that do not exist yet. Absent means the host refuses to start (never a default). The snapshotter is not a port here. */
export interface DaemonEntryPorts {
  readonly pty?: PtyPort;
  readonly ptyGitRunner?: GitRunner;
}

export interface DaemonEntryDeps {
  /** `process.parentPort` of the utility process; absent when the file was started any other way. */
  readonly parentPort: ParentPortLike | undefined;
  readonly process: EntryProcess;
  /** The environment main gave this process. Copied here; the host never reads `process.env` itself. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly platform: string;
  readonly execArgv: readonly string[];
  /** One closed, redacted log line per call. */
  readonly stderr: (line: string) => void;
  readonly clock?: Clock;
  readonly storage?: StoragePort;
  readonly ports?: DaemonEntryPorts;
  /** Design 3, step 2: default 10000. */
  readonly initTimeoutMs?: number;
  /** The timer for the init wait (default: the global one). Injected so a test needs no wall clock. */
  readonly timers?: EntryTimers;
}

export interface EntryTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface DaemonEntryHandle {
  /** Resolves `true` when the host sent `ready`, `false` when startup ended in an exit. */
  readonly started: Promise<boolean>;
  /** Resolves with the exit code once the entry decided to end the process (after `exit` was called or the process was released). */
  readonly finished: Promise<number>;
}

export const DEFAULT_INIT_TIMEOUT_MS = 10_000;
const DEBUG_FLAG = /^--(?:inspect|debug|remote-debugging)/i;
const REASON = /^[a-z][a-z0-9_]{0,63}$/;
/** Opaque handles under Code OSS's typings (ADR 0005), as in compose.ts. The init timer is unref'd: the parent port keeps the process alive. */
const realTimers: EntryTimers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms) as unknown as NodeJS.Timeout;
    t.unref();
    return t;
  },
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};
const realClock: Clock = { now: () => Date.now(), monotonic: () => performance.now() };

/** True for an argument that opens a debugger or inspector port, in any spelling Node accepts. */
export const isDebugFlag = (arg: string): boolean => DEBUG_FLAG.test(arg);

function reasonOf(error: unknown): string | undefined {
  if (!(error instanceof AxisError)) return undefined;
  const r = error.detail["reason"];
  return typeof r === "string" && REASON.test(r) ? r : undefined;
}

export function runDaemonEntry(deps: DaemonEntryDeps): DaemonEntryHandle {
  let resolveStarted: (ok: boolean) => void = () => undefined;
  let resolveFinished: (code: number) => void = () => undefined;
  const started = new Promise<boolean>((r) => void (resolveStarted = r));
  const finished = new Promise<number>((r) => void (resolveFinished = r));
  const handle: DaemonEntryHandle = { started, finished };
  const clock = deps.clock ?? realClock;
  const redactor = new Redactor();

  const line = (text: string): void => {
    try {
      deps.stderr(redactor.redactString(text));
    } catch {
      // a failing log line never changes the outcome
    }
  };

  /** A refusal before the channel exists: best-effort `fatal` straight on the parent port, then exit. */
  const refuseEarly = (reason: string): DaemonEntryHandle => {
    try {
      deps.parentPort?.postMessage({ type: "fatal", code: "E_INVALID_ARGUMENT", reason });
    } catch {
      // the port may not exist or may be closed
    }
    line(`axis.daemon refused to start: ${reason}`);
    deps.process.exitCode = EXIT.BAD_CONFIG;
    resolveStarted(false);
    resolveFinished(EXIT.BAD_CONFIG);
    deps.process.exit(EXIT.BAD_CONFIG);
    return handle;
  };

  // Step 1: the process must be what the design says it is.
  if (deps.parentPort === undefined || typeof deps.parentPort.postMessage !== "function") return refuseEarly("not_utility_process");
  if (deps.execArgv.some(isDebugFlag)) return refuseEarly("debug_flag_refused");
  // Main always forks with an empty `execArgv`; `--require`, `--import` and loaders would run code before this file does.
  if (deps.execArgv.length > 0) return refuseEarly("exec_args_refused");
  const nodeOptions = deps.env["NODE_OPTIONS"];
  if (nodeOptions !== undefined && nodeOptions !== "") return refuseEarly("node_options_refused");

  // Step 2: listen before anything awaits.
  const control = adaptParentPort(deps.parentPort);
  const mux = new ChannelMux(control.channel);
  const client = new ControlClient({ mux });
  let initTimer: unknown;
  const timers: EntryTimers = deps.timers ?? realTimers;
  let ended = false;
  const release = (): void => {
    if (initTimer !== undefined) timers.clear(initTimer);
    initTimer = undefined;
    client.dispose();
    mux.dispose();
    control.dispose();
  };
  const end = (code: ExitCode, released: boolean): void => {
    if (ended) return;
    ended = true;
    deps.process.exitCode = code;
    release(); // the channel no longer holds the event loop: a released host ends by draining
    resolveFinished(code);
    if (!released) deps.process.exit(code);
  };
  const failStartup = (error: unknown): void => {
    const code = exitCodeForStartupError(error);
    const summary = summarizeError(error);
    const reason = reasonOf(error);
    try {
      client.send({ type: "fatal", code: summary.code ?? "E_INTERNAL", ...(reason === undefined ? {} : { reason }) });
    } catch {
      // the channel may be closed
    }
    line(`axis.daemon start failed: ${summary.code ?? "unknown"}${reason === undefined ? "" : ` ${reason}`}`);
    resolveStarted(false);
    end(code, false);
  };

  // Step 3: exactly one init, bounded.
  initTimer = timers.set(() => failStartup(new AxisError("E_INVALID_ARGUMENT", "No init message", { reason: "init_timeout" })), deps.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS);
  client.onInit((raw) => {
    if (initTimer !== undefined) timers.clear(initTimer);
    initTimer = undefined;
    try {
      // Step 4.
      const config = parseHostConfig(raw, redactor);
      if (config.platform !== deps.platform) throw new AxisError("E_INVALID_ARGUMENT", "The platform does not match", { reason: "platform_mismatch" });
      const logger = createLogger({ redactor, clock, level: config.logLevel, sink: { write: (text) => void line(text) } });
      // Step 5. `ports.pty` and `ptyGitRunner` are whatever the caller has: nothing in production yet, so this throws.
      const composed = composeDaemonHost({
        config,
        control: client,
        mux,
        portSource: control,
        ports: { clock, storage: deps.storage ?? createNodeStorage(), redactor, logger, env: { ...deps.env }, cwd: deps.cwd },
        pty: deps.ports?.pty,
        ptyGitRunner: deps.ports?.ptyGitRunner,
        snapshotter: gitSnapshotRunSnapshotter,
        process: deps.process,
        exit: (code, info) => end(code, info.released),
      });
      composed.start().then(() => resolveStarted(true), failStartup);
    } catch (e) {
      failStartup(e);
    }
  });
  return handle;
}
