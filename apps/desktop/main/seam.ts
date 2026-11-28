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
  AckedHandover,
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
/** How long a child may take to send its first message before its hand-over window opens anyway (OS-3h review S2). */
export const HANDOVER_START_GRACE_MS = 30_000;
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
  // Cut to MAX_STDERR_LINE characters BEFORE escaping, so a flood line costs main only a bounded amount of work.
  const out = lines.slice(0, MAX_STDERR_LINES).map((l) => `[${service} stderr] ${escape(l.slice(0, MAX_STDERR_LINE))}`);
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

  // The acknowledged control hand-over (OS-3h, own-shell-main-seam.md §3a). `pids` are the live children's, for a teardown by
  // exact pid; `ptyHeld` holds the pty process down after a failed hand-over until the next daemon start.
  const pids: { pty: number | undefined; daemon: number | undefined } = { pty: undefined, daemon: undefined };
  let ptyHeld = false;
  let ptyAlive = false;
  let ptyChildren = 0;
  let restartedForPty = 0;
  // A child still loading cannot answer (OS-3h review S2): its window opens at its first message, or after the start grace.
  const firstMessage = { pty: false, daemon: false };
  const spawnedAt = { pty: 0, daemon: 0 };
  const windowOpen = (side: "pty" | "daemon"): boolean => firstMessage[side] || deps.now() - spawnedAt[side] >= HANDOVER_START_GRACE_MS;
  let daemonHandle: DaemonChild | undefined;
  // The pty child main forked last. createPtySpawn may wrap it before the supervisor (and so the hand-over) sees it, so an answer's
  // instance is checked here against the fork itself.
  let ptyFork: PtyForkedChild | undefined;
  const handover = new AckedHandover<P>({
    createChannel: deps.createChannel,
    closePort: deps.closePort,
    timers,
    windowOpen,
    teardown: (side) => {
      const pid = pids[side];
      if (pid !== undefined) deps.killPid(pid, "SIGKILL");
    },
    onFailed: () => {
      // Tear the pty process down and hold it until the next daemon start: the daemon stays up, every pty-backed call fails closed.
      ptyHeld = true;
      if (pids.pty !== undefined) deps.killPid(pids.pty, "SIGKILL");
    },
    onEvent: (event, fields) => {
      const line = `axis pty: ${event}${fields.generation === undefined ? "" : ` generation=${fields.generation}`}${fields.side === undefined ? "" : ` side=${fields.side}`}`;
      if (event === "handover_failed" || event === "teardown" || event === "post_failed") log.warn(line);
      else log.trace(line);
    },
  });
  const note = (side: "pty" | "daemon", message: unknown, from: unknown): void => {
    const m = message as { type?: unknown; generation?: unknown } | null;
    if (typeof m !== "object" || m === null || Object.keys(m).length !== 2 || typeof m.generation !== "number" || !Number.isSafeInteger(m.generation)) return;
    if (m.type === "pty-control-adopted") handover.adopted(side, m.generation, from as never);
    else if (m.type === "pty-control-closed") handover.closed(side, m.generation, from as never);
  };

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
      fork: (childEnv) =>
        forkPtyChild(
          deps,
          childEnv,
          (pid) => {
            pids.pty = pid;
            spawnedAt.pty = deps.now();
            firstMessage.pty = false;
          },
          (m, from) => {
            if (from !== ptyFork) return; // an answer from an instance that is no longer the current one
            firstMessage.pty = true;
            note("pty", m, undefined);
          },
          (handle) => (ptyFork = handle),
        ),
      onEvent: (event) => log.warn(`axis pty: ${event}`),
    }),
    timers,
    now: deps.now,
    onEvent: (event, fields) => {
      const line = `axis pty: ${event}${fields.code === undefined ? "" : ` code=${fields.code}`}${fields.reason === undefined ? "" : ` reason=${fields.reason}`}`;
      // The pty process will not come back: a daemon start waiting for it is reported failed, never left waiting in silence.
      if (event === "failed") queueMicrotask(() => supervisor.failHeld("pty_unavailable"));
      if (event === "failed") log.error(line);
      else if (event === "restart_scheduled") log.warn(line);
      else log.trace(line);
    },
    // Held down after a failed hand-over until the next daemon start (`resume()` below).
    mayStart: () => !ptyHeld,
    onChild: (child, alive) => {
      ptyAlive = alive;
      if (!alive) pids.pty = undefined;
      handover.pty(child as PtyForkedChild & P, alive);
      if (!alive) return;
      ptyChildren++;
      // The daemon never starts without a pty process: a held start goes ahead now, and a daemon that ended pty_required
      // (its wait for a control port ran out while this process was down) is started again, once per pty child.
      supervisor.resume();
      if (restartedForPty !== ptyChildren && supervisor.restartAfterPtyRequired()) restartedForPty = ptyChildren;
    },
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
    onHandover: (message) => note("daemon", message, daemonHandle),
    // The daemon never starts without a live pty process (OS-3h). A start attempt releases a hold left by a failed hand-over (so a
    // daemon that crashes later is not stranded: review S1), and a pty process that failed for good fails the start, reported.
    mayStart: () => {
      if (ptyAlive) return true;
      if (pty.state() === "failed") {
        queueMicrotask(() => supervisor.failHeld("pty_unavailable"));
        return false;
      }
      if (ptyHeld) {
        ptyHeld = false;
        queueMicrotask(() => pty.resume());
      }
      return false;
    },
    spawn: () => {
      const child = forkFixed(deps, DAEMON_FILE, "axis-daemon", daemonEnvironment(deps.env));
      pids.daemon = child.pid;
      spawnedAt.daemon = deps.now();
      firstMessage.daemon = false;
      child.on("message", (() => void (firstMessage.daemon = true)) as never);
      const handle: DaemonChild = {
        // A `connect` carries exactly one port (slice 3.2); every other message carries none.
        postMessage: (message, transfer) => (transfer === undefined ? child.postMessage(message) : child.postMessage(message, [...transfer])),
        // The supervisor kills on its ready timeout and after the stop grace: SIGKILL by exact pid (utilityProcess.kill() sends SIGTERM,
        // which a daemon with a blocked event loop never handles, so it would keep its data lock until main quits).
        kill: () => (child.pid !== undefined ? deps.killPid(child.pid, "SIGKILL") : child.kill()),
        onMessage: (handler) => onChild(child, "message", (m: unknown) => m, handler),
        onExit: (handler) => onChild(child, "exit", (code: unknown) => (typeof code === "number" ? code : null), handler),
      };
      daemonHandle = handle;
      // The control channel (pty-exec-node.md §6.3): a new one to both processes now, and none to this child after its exit.
      child.once("exit", () => {
        if (pids.daemon === child.pid) pids.daemon = undefined;
        handover.daemon(handle as DaemonChild & P, false);
      });
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
function forkPtyChild<P>(deps: SeamDeps<P>, env: Record<string, string>, onPid: (pid: number | undefined) => void, onNote: (message: unknown, from: PtyForkedChild) => void, onHandle: (handle: PtyForkedChild) => void): PtyForkedChild {
  const child = forkFixed(deps, PTY_FILE, "axis-pty", env);
  onPid(child.pid);
  // The pty process's answers in the hand-over (OS-3h), bound to THIS instance; it sends main nothing else. The listener goes with it.
  const listener = ((m: unknown) => onNote(m, handle)) as never;
  child.on("message", listener);
  child.once("exit", () => void child.off("message", listener));
  const handle: PtyForkedChild = {
    // `pty-control` carries exactly one port; main sends the pty process nothing else.
    postMessage: (message, transfer) => (transfer === undefined ? child.postMessage(message) : child.postMessage(message, [...transfer])),
    kill: (signal) => {
      // utilityProcess.kill() sends SIGTERM on POSIX only, so SIGKILL goes by pid (the supervisor sends it 5 s after SIGTERM).
      if (signal === "SIGKILL" && child.pid !== undefined) deps.killPid(child.pid, "SIGKILL");
      else child.kill();
    },
    onExit: (handler) => onChild(child, "exit", (code: unknown) => (typeof code === "number" ? code : null), handler),
  };
  onHandle(handle);
  return handle;
}
