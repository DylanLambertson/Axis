// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError, Redactor } from "@axis/audit";
import type { ElectronPortLike } from "@axis/daemon";
import type { GitRunner } from "@axis/git-ops";
import { createPtyControlSlot, type ControlPortLike, type PtyControlSlot } from "./bindings/pty-control.js";
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
 * The utility process entry logic (ticket X1, design `docs/design/daemon-host-entry.md`). The forked file (the shell's, OS-3;
 * in the legacy shell the overlay file `vs/axis/daemon/node/axisDaemonMain.ts`) only hands this function the real `process`,
 * `process.parentPort` and the environment main gave the process; everything that can be tested without Electron is here.
 *
 * What it does, in order, and what fails closed (every refusal is exit code 78 and a `fatal` message of closed codes, before any
 * data directory, lock, file or listener exists):
 * 1. not a utility process (no parent port), a debugging or inspector flag in `execArgv`, or a non-empty `NODE_OPTIONS`,
 *    `NODE_TLS_REJECT_UNAUTHORIZED` or `NODE_USE_ENV_PROXY` in the environment (any letter case on Windows, where the
 *    environment is case-insensitive): refused. The last two would turn off certificate checks or route Node's own HTTP
 *    through an environment proxy for every request the daemon makes (ADR 0009 decision 4);
 * 2. the parent port is adapted BEFORE anything awaits, so the one `init` message cannot be lost;
 * 3. exactly one `init` within `initTimeoutMs` (design 3, step 2); none in time: refused;
 * 4. `HostConfig` parsed strictly; a `platform` that is not the process's own: refused;
 * 5. `composeDaemonHost` with the real clock, the real storage, the one environment copy and the real `process` for signals. The
 *    run snapshotter is always the real one (`gitSnapshotRunSnapshotter`, `@axis/git-snapshot`, ticket H13). The pty port is the
 *    one main transfers in a `{ type: "pty-control" }` message (PV-X1a, `docs/design/pty-exec-node.md` §5a), and the pty git
 *    runner is the strict mapping over it. The host is composed only once both `init` and a control port arrived, within
 *    `initTimeoutMs`; a port that never comes is `pty_required` (exit 78). A later `pty-control` replaces the port (what was in flight
 *    fails closed), and a closed port makes pty requests unavailable until the next. `deps.ports.pty` (tests) replaces all of this:
 *    a `pty-control` is then closed. No fake is imported by this file, by the overlay entry or by anything in `src`.
 * 6. a stop always ends in `process.exit` with the lifecycle's code: at once when the host was not released, and one unref'd timer
 *    after the release otherwise (an Electron utility process never ends by draining, PV-X1b).
 *
 * It opens no socket and no port; `connect` messages arrive only on the parent port, which only the parent can write.
 */

/**
 * Environment variables that change how Node itself loads code or makes TLS and HTTP connections, refused at start with
 * their closed reason when set to anything but the empty string.
 */
export const REFUSED_ENV: ReadonlyArray<readonly [string, string]> = Object.freeze([
  Object.freeze(["NODE_OPTIONS", "node_options_refused"] as const),
  Object.freeze(["NODE_TLS_REJECT_UNAUTHORIZED", "tls_override_refused"] as const),
  Object.freeze(["NODE_USE_ENV_PROXY", "env_proxy_refused"] as const),
]);

/** True when `name` holds a non-empty value; on Windows any key that equals `name` ignoring letter case counts. */
export function envSet(env: Readonly<Record<string, string | undefined>>, name: string, platform: string): boolean {
  if (platform !== "win32") {
    const v = env[name];
    return v !== undefined && v !== "";
  }
  const upper = name.toUpperCase();
  return Object.keys(env).some((k) => k.toUpperCase() === upper && env[k] !== undefined && env[k] !== "");
}

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
  /** The timer for the init wait and the exit after a released shutdown (default: the global one, unref'd). Injected so a test needs no wall clock. */
  readonly timers?: EntryTimers;
}

export interface EntryTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface DaemonEntryHandle {
  /** Resolves `true` when the host sent `ready`, `false` when startup ended in an exit. */
  readonly started: Promise<boolean>;
  /** Resolves with the exit code once the entry decided to end the process: after `exit` was called, or once the host was released (`exit` then follows one macrotask later). */
  readonly finished: Promise<number>;
}

export const DEFAULT_INIT_TIMEOUT_MS = 10_000;
const DEBUG_FLAG = /^--(?:inspect|debug|remote-debugging)/i;
const REASON = /^[a-z][a-z0-9_]{0,63}$/;
/** Opaque handles under Code OSS's typings (ADR 0005), as in compose.ts. Unref'd: neither timer may keep a Node process alive on its own. */
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
/**
 * The one `execArgv` a daemon may be forked with: the flag that stops SIGUSR1 from opening the inspector under plain Node (audit
 * C M1). Electron's utility process ignores it, so there the guard in `signal-guard.ts` is the control.
 */
export const EXEC_ARGV_ALLOWED = "--disable-sigusr1";
/** Empty, or exactly `[EXEC_ARGV_ALLOWED]`. */
export const execArgvAllowed = (args: readonly string[]): boolean => args.length === 0 || (args.length === 1 && args[0] === EXEC_ARGV_ALLOWED);

function reasonOf(error: unknown): string | undefined {
  if (!(error instanceof AxisError)) return undefined;
  const r = error.detail["reason"];
  return typeof r === "string" && REASON.test(r) ? r : undefined;
}

/** The one closed line the entry writes when SIGUSR1 arrives (the inspector stays closed). */
export const DEBUG_SIGNAL_LINE = "axis.daemon ignored SIGUSR1: the inspector stays closed";

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

  // Audit C M1: SIGUSR1 would open Node's unauthenticated inspector on 127.0.0.1:9229, from which any local user could read the
  // heap and every revealed credential. Under Electron's utility process `--disable-sigusr1` is not honoured, so a listener is
  // the control: the file main forks installs a silent one through `signal-guard.ts`, its one static import, before this module
  // graph loads. This one is for callers that run the entry directly; it writes the closed line. It is installed first, on
  // every path, and never removed: with no listener the signal's default applies again.
  let signalled = false;
  deps.process.on("SIGUSR1", () => {
    if (signalled) return;
    signalled = true;
    line(DEBUG_SIGNAL_LINE);
  });

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
  // `--require`, `--import` and loaders would run code before this file does: the one allowed argument is the flag that keeps
  // the inspector closed under plain Node (audit C M1), alone; it is harmless under Electron, which ignores it.
  if (!execArgvAllowed(deps.execArgv)) return refuseEarly("exec_args_refused");
  for (const [name, reason] of REFUSED_ENV) {
    if (envSet(deps.env, name, deps.platform)) return refuseEarly(reason);
  }

  // Step 2: listen before anything awaits.
  const control = adaptParentPort(deps.parentPort);
  const mux = new ChannelMux(control.channel);
  const client = new ControlClient({ mux });
  let initTimer: unknown;
  const timers: EntryTimers = deps.timers ?? realTimers;
  let ended = false;
  // The parent port's one port handler is the entry's: a `pty-control` goes to the pty slot, any other port to the composition's
  // handler (the connect router), which registers through `portSource` below.
  const slot: PtyControlSlot | undefined = deps.ports?.pty === undefined ? createPtyControlSlot() : undefined;
  let connectHandler: ((data: unknown, port: ElectronPortLike) => void) | undefined;
  const closePort = (port: { close(): void }): void => {
    try {
      port.close();
    } catch {
      // already closed
    }
  };
  control.onPort((data, port) => {
    const kind = typeof data === "object" && data !== null ? (data as { type?: unknown }).type : undefined;
    if (kind === "pty-control") {
      const exact = Object.keys(data as object).length === 1;
      if (slot === undefined || ended || !exact || typeof (port as { removeListener?: unknown }).removeListener !== "function") return closePort(port);
      slot.attach(port as unknown as ControlPortLike);
      compose();
      return;
    }
    if (connectHandler === undefined) return closePort(port);
    connectHandler(data, port);
  });
  const portSource = {
    onPort(handler: (data: unknown, port: ElectronPortLike) => void): () => void {
      if (connectHandler !== undefined) throw new AxisError("E_CONFLICT", "A port handler is already set");
      connectHandler = handler;
      return () => {
        if (connectHandler === handler) connectHandler = undefined;
      };
    },
  };
  const release = (): void => {
    if (initTimer !== undefined) timers.clear(initTimer);
    initTimer = undefined;
    client.dispose();
    mux.dispose();
    control.dispose();
    slot?.dispose();
  };
  const end = (code: ExitCode, released: boolean): void => {
    if (ended) return;
    ended = true;
    deps.process.exitCode = code;
    release();
    resolveFinished(code);
    const exit = (): unknown => deps.process.exit(code);
    // Released: the database, the lock, every listener and the pty port are closed, so nothing can still write. Under Node the
    // process now ends by draining, but an Electron utility process never does (its parent port keeps it alive even with no
    // listener; PV-X1b), so it would wait for the supervisor's kill. The exit comes one macrotask later, on the unref'd timer.
    if (released) timers.set(exit, 0);
    else exit();
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

  // Step 3: exactly one init and (production) a pty control port, both within the bound. The init is checked when it arrives.
  let init: { readonly config: ReturnType<typeof parseHostConfig>; readonly logger: ReturnType<typeof createLogger> } | undefined;
  let initSeen = false;
  let composed = false;
  initTimer = timers.set(() => {
    initTimer = undefined;
    if (!initSeen) failStartup(new AxisError("E_INVALID_ARGUMENT", "No init message", { reason: "init_timeout" }));
    else failStartup(new AxisError("E_INVALID_ARGUMENT", "No pty control port", { reason: "pty_required" }));
  }, deps.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS);
  client.onInit((raw) => {
    if (initSeen) return;
    initSeen = true;
    try {
      // Step 4.
      const config = parseHostConfig(raw, redactor);
      if (config.platform !== deps.platform) throw new AxisError("E_INVALID_ARGUMENT", "The platform does not match", { reason: "platform_mismatch" });
      init = { config, logger: createLogger({ redactor, clock, level: config.logLevel, sink: { write: (text) => void line(text) } }) };
    } catch (e) {
      failStartup(e);
      return;
    }
    compose();
  });
  function compose(): void {
    if (composed || ended || init === undefined || (slot !== undefined && !slot.attached())) return;
    composed = true;
    if (initTimer !== undefined) timers.clear(initTimer);
    initTimer = undefined;
    const { config, logger } = init;
    try {
      // Step 5. The pty port is the slot's (production) or the caller's (tests); with the slot the git runner is the mapping over it.
      const host = composeDaemonHost({
        config,
        control: client,
        mux,
        portSource,
        ports: { clock, storage: deps.storage ?? createNodeStorage(), redactor, logger, env: { ...deps.env }, cwd: deps.cwd },
        pty: slot?.port ?? deps.ports?.pty,
        ptyGitRunner: slot === undefined ? deps.ports?.ptyGitRunner : undefined,
        snapshotter: gitSnapshotRunSnapshotter,
        process: deps.process,
        exit: (code, info) => end(code, info.released),
      });
      host.start().then(() => resolveStarted(true), failStartup);
    } catch (e) {
      failStartup(e);
    }
  }
  return handle;
}
