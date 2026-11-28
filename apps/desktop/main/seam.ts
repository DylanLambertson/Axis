// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// OS-3.1: main's seam to the daemon and the pty process (docs/design/own-shell-main-seam.md §3), ported from the overlay's
// axisMainSeam.ts and axisMainPty.ts. Electron is injected (structural types), so test/seam.test.ts runs it under plain Node.
//
// - Main forks exactly two FIXED files of its own bundle, `daemon.cjs` and `pty.cjs`, through forkUtility (OS-2): the fixed
//   execArgv, an allow-listed environment, the bundle directory as cwd, piped and drained stdio. No path, argument or environment
//   comes from a renderer; this slice adds no renderer IPC at all.
// - The anchor store is read before the first spawn (a keychain prompt must not use up the daemon's anchor wait); the pty process
//   starts first, then the daemon; each child is reported to the control hand-over so both get a fresh channel on every (re)start.
// - Shutdown: the daemon first, then the pty process, bounded.
// - The answers: anchor and settings; `native.confirm` is refused (no app window can be named until slice 3.2) and `trust.check`
//   answers false. Tier 4 is refused until slice 3.2.
import { dirname, isAbsolute, join } from "node:path";
import {
  ControlHandover,
  DEFAULT_PTY_POLICY,
  DEFAULT_RESTART_POLICY,
  DaemonSupervisor,
  PtySupervisor,
  anchorFilePath,
  createAnchorFile,
  createAnchorStore,
  createMainAnswers,
  createPtySpawn,
  preparePtyScratchRoot,
  ptyScratchRoot,
  resolvePtyPrograms,
  shouldStartDaemon,
  shutdownInOrder,
  type AnchorCipher,
  type DaemonChild,
  type MainAnswers,
  type PtyForkedChild,
  type SupervisedConfig,
  type SupervisorTimers,
  daemonEnvironment,
} from "@axis/daemon-host/main";
import type { DesktopPlatform } from "@axis/desktop-main";
import { forkUtility } from "./hardening.js";

export const DAEMON_FILE = "daemon.cjs";
export const PTY_FILE = "pty.cjs";
const MAX_STDERR_LINE = 512;
/** How long main waits for the daemon's stop before it stops the pty process anyway: the daemon's own kill bound, plus a margin. */
export const DAEMON_STOP_BOUND_MS = DEFAULT_RESTART_POLICY.stopGraceMs + 1_000;
/** The whole shutdown main waits for before it quits anyway: the daemon's bound, then the pty process's own stop grace, plus a margin. */
export const SEAM_SHUTDOWN_BOUND_MS = DAEMON_STOP_BOUND_MS + DEFAULT_PTY_POLICY.stopGraceMs + 2_000;

/** What main uses of an Electron `UtilityProcess`. */
export interface UtilityChildLike {
  readonly pid?: number | undefined;
  readonly stdout?: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  readonly stderr?: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  postMessage(message: unknown, transfer?: unknown[]): void;
  kill(): boolean;
  on(event: "message" | "exit", listener: (value: never) => void): unknown;
  off(event: "message" | "exit", listener: (value: never) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
}

export interface SeamLog {
  trace(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

export interface SeamDeps<P> {
  readonly platform: DesktopPlatform;
  /** `app.isPackaged`: a packaged build starts neither process until the owner's packaging ADR (`shouldStartDaemon`). */
  readonly packaged: boolean;
  /** The bundle directory (dist/app): the forked files' directory, and their cwd. Absolute. */
  readonly bundleDir: string;
  readonly config: SupervisedConfig;
  /** Main's environment; the children get allow-listed copies only. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly utilityProcess: { fork(entry: string, args: string[], options: never): UtilityChildLike };
  readonly createChannel: () => { readonly port1: P; readonly port2: P };
  readonly closePort: (port: P) => void;
  /** `safeStorage` as the anchor cipher (available after `ready`). */
  readonly cipher: AnchorCipher;
  readonly randomBytes: (n: number) => Uint8Array;
  readonly hmacSha256: (key: Uint8Array, text: string) => Uint8Array;
  readonly now: () => number;
  readonly timers: SupervisorTimers;
  /** `process.kill`, for the pty child's SIGKILL (utilityProcess.kill sends SIGTERM only). */
  readonly killPid: (pid: number, signal: "SIGKILL") => void;
  readonly log: SeamLog;
}

export interface MainSeam {
  readonly supervisor: DaemonSupervisor;
  readonly answers: MainAnswers;
  /** Settles once the anchor store was read and the pty process started; the daemon is spawned right after. */
  readonly started: Promise<void>;
  /** The daemon first, then the pty process; bounded. Never rejects. */
  shutdown(): Promise<void>;
}

const MAX_STDERR_LINES = 20;

/**
 * A child's stderr as main's log takes it: split into lines, every character outside printable ASCII escaped (so no escape sequence
 * reaches a terminal and no line can pass for one of main's own), each line bounded and tagged with the child's fixed prefix, at
 * most MAX_STDERR_LINES per chunk. Development builds only (the packaged log drops trace lines).
 */
export function childStderrLines(service: "axis-daemon" | "axis-pty", chunk: unknown): string[] {
  const raw = chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : String(chunk);
  const lines = raw.split(/\r\n|\r|\n/).filter((l) => l.trim() !== "");
  const escape = (l: string): string => [...l].map((c) => (/^[\x20-\x7e]$/.test(c) ? c : `\\u{${c.codePointAt(0)?.toString(16)}}`)).join("");
  const out = lines.slice(0, MAX_STDERR_LINES).map((l) => `[${service} stderr] ${escape(l).slice(0, MAX_STDERR_LINE)}`);
  if (lines.length > MAX_STDERR_LINES) out.push(`[${service} stderr] (${lines.length - MAX_STDERR_LINES} more lines dropped)`);
  return out;
}

/** Forks one fixed bundle file through forkUtility, stdout drained and dropped, stderr to the log (bounded, trace only). */
function forkFixed<P>(deps: SeamDeps<P>, file: string, service: "axis-daemon" | "axis-pty", env: Readonly<Record<string, string | undefined>>): UtilityChildLike {
  if (!isAbsolute(deps.bundleDir)) throw new Error("the bundle directory must be absolute");
  const entry = join(deps.bundleDir, file);
  const child = forkUtility(deps.utilityProcess as never, entry, service, env, deps.bundleDir, deps.platform) as UtilityChildLike;
  child.stdout?.on("data", () => {
    // Drained and dropped: an unread pipe would block the child.
  });
  child.stderr?.on("data", (chunk) => {
    for (const line of childStderrLines(service, chunk)) deps.log.trace(line);
  });
  return child;
}

function onChild<T>(child: UtilityChildLike, event: "message" | "exit", map: (value: never) => T, handler: (value: T) => void): () => void {
  const listener = (value: never): void => handler(map(value));
  child.on(event, listener);
  return () => void child.off(event, listener);
}

/** Starts the seam, or returns undefined in a packaged build. Never throws for a child that fails; the supervisors handle it. */
export function startMainSeam<P>(deps: SeamDeps<P>): MainSeam | undefined {
  // One start gate for both processes (supervisor.ts): development builds only, until the packaging ADR. The own shell's
  // equivalent of Code OSS's `isBuilt` is `app.isPackaged`.
  if (!shouldStartDaemon(deps.packaged)) {
    deps.log.trace("axis daemon: not started in a packaged build");
    return undefined;
  }
  if (!isAbsolute(deps.bundleDir)) throw new Error("the bundle directory must be absolute");
  const { config, log, timers } = deps;

  const handover = new ControlHandover<P>({
    createChannel: deps.createChannel,
    closePort: deps.closePort,
    onEvent: (event, fields) => (event === "post_failed" ? log.warn(`axis pty: ${event} side=${fields.side}`) : log.trace(`axis pty: ${event}`)),
  });

  // The pty process (pty-exec-node.md §6.4). Its own environment comes from createPtySpawn (the daemon's allow-list plus
  // SSH_AUTH_SOCK and the handed-over program paths); a program found inside the data root is never chosen.
  const base = dirname(config.dataDir);
  const excludeDirs = [base, config.worktreeRoot];
  const programs = resolvePtyPrograms(deps.env, config.platform, excludeDirs);
  log.trace(`axis pty: git=${programs.gitPath === undefined ? "missing" : "found"} gh=${programs.ghPath === undefined ? "missing" : "found"}`);
  const scratch = ptyScratchRoot(config.dataDir);
  const scratchRoot = config.platform !== "win32" && preparePtyScratchRoot(scratch) ? scratch : undefined;
  const pty = new PtySupervisor({
    spawn: createPtySpawn({
      platform: config.platform,
      shellEnv: deps.env,
      programs,
      excludeDirs,
      scratchRoot,
      fork: (childEnv) => forkPtyChild(deps, childEnv),
      onEvent: (event) => log.warn(`axis pty: ${event}`),
    }),
    timers,
    now: deps.now,
    onEvent: (event, fields) => {
      const line = `axis pty: ${event}${fields.code === undefined ? "" : ` code=${fields.code}`}${fields.reason === undefined ? "" : ` reason=${fields.reason}`}`;
      if (event === "failed") log.error(line);
      else if (event === "restart_scheduled") log.warn(line);
      else log.trace(line);
    },
    onChild: (child, alive) => handover.pty(child as PtyForkedChild & P, alive),
  });

  const answers = createMainAnswers({
    // `<base>/anchor/audit-anchor.v1`, next to (never inside) the daemon's data directory, encrypted with safeStorage.
    anchors: createAnchorStore(deps.cipher, createAnchorFile(anchorFilePath(config.dataDir))),
    // Slice 3.1: no app window can be named, so every native confirmation is refused at once (the queue's closed reason).
    dialog: { confirm: async () => false },
    windows: { codeWindowOf: () => undefined },
    // No trust model in the own shell (OS-3b): a trust question main cannot decide is `false`.
    trust: { trustModel: () => undefined },
    // No settings store yet (OS-4): every setting is unset, so main answers `settings.result` with `null` and the daemon applies its own
    // defaults (`axis.git.runHooks` off; no `axis.cliAgents` entry, so a CLI run is refused).
    settings: { inspect: () => ({}) },
    platform: config.platform,
    now: deps.now,
    onEvent: (e) => log.warn(`axis daemon: ${e.event}${"reason" in e ? ` reason=${e.reason}` : ""}`),
  });

  const supervisor = new DaemonSupervisor({
    config,
    randomBytes: deps.randomBytes,
    hmacSha256: deps.hmacSha256,
    now: deps.now,
    timers,
    onRequest: (message, reply) => answers.onRequest(message, reply),
    spawn: () => {
      const child = forkFixed(deps, DAEMON_FILE, "axis-daemon", daemonEnvironment(deps.env));
      const handle: DaemonChild = {
        // A `connect` carries exactly one port (slice 3.2); every other message carries none.
        postMessage: (message, transfer) => (transfer === undefined ? child.postMessage(message) : child.postMessage(message, [...transfer])),
        // The supervisor kills on its ready timeout and after the stop grace: SIGKILL by exact pid (utilityProcess.kill() sends SIGTERM,
        // which a daemon with a blocked event loop never handles, so it would keep its data lock until main quits).
        kill: () => (child.pid !== undefined ? deps.killPid(child.pid, "SIGKILL") : child.kill()),
        onMessage: (handler) => onChild(child, "message", (m: unknown) => m, handler),
        onExit: (handler) => onChild(child, "exit", (code: unknown) => (typeof code === "number" ? code : null), handler),
      };
      // The control channel (pty-exec-node.md §6.3): a new one to both processes now, and none to this child after its exit.
      child.once("exit", () => handover.daemon(handle as DaemonChild & P, false));
      handover.daemon(handle as DaemonChild & P, true);
      return handle;
    },
    onEvent: (event, fields) => {
      const line = `axis daemon: ${event}${fields.code === undefined ? "" : ` code=${fields.code}`}${fields.reason === undefined ? "" : ` reason=${fields.reason}`}`;
      if (event === "failed" || event === "fatal_reported") log.error(line);
      else if (event === "restart_scheduled" || event === "degraded" || event === "unanswered_request") log.warn(line);
      else log.trace(line);
    },
  });

  // Read the anchor store first, start the pty process, then spawn the daemon.
  const started = Promise.all([answers.prepare(), Promise.resolve().then(() => pty.start())]).then(
    () => undefined,
    () => undefined,
  );
  let stopping: Promise<void> | undefined;
  // A quit during the anchor read or the pty start must not spawn the daemon only to stop it.
  void started.then(() => {
    if (stopping === undefined) supervisor.start();
  });

  return {
    supervisor,
    answers,
    started,
    shutdown: () => {
      stopping ??= started
        .then(() => shutdownInOrder(() => supervisor.shutdown(), pty, timers, DAEMON_STOP_BOUND_MS))
        .catch(() => undefined)
        .then(() => answers.idle())
        .catch(() => undefined)
        .finally(() => {
          answers.dispose();
          handover.dispose();
        });
      return stopping;
    },
  };
}

/** The pty child: the fixed `pty.cjs`, with exactly the launch environment createPtySpawn built. */
function forkPtyChild<P>(deps: SeamDeps<P>, env: Record<string, string>): PtyForkedChild {
  const child = forkFixed(deps, PTY_FILE, "axis-pty", env);
  return {
    // `pty-control` carries exactly one port; main sends the pty process nothing else.
    postMessage: (message, transfer) => (transfer === undefined ? child.postMessage(message) : child.postMessage(message, [...transfer])),
    kill: (signal) => {
      // utilityProcess.kill() sends SIGTERM on POSIX only, so SIGKILL goes by pid (the supervisor sends it 5 s after SIGTERM).
      if (signal === "SIGKILL" && child.pid !== undefined) deps.killPid(child.pid, "SIGKILL");
      else child.kill();
    },
    onExit: (handler) => onChild(child, "exit", (code: unknown) => (typeof code === "number" ? code : null), handler),
  };
}
