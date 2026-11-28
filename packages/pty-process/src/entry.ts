// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { PTY_ENV_GH, PTY_ENV_GIT, PTY_ENV_SCRATCH, readPtyExecConfig } from "./config.js";
import { defaultEndpointDir, type EndpointHostConfig } from "./endpoint-host.js";
import { createNodeExec } from "./exec-node.js";
import { adaptMessagePort, type MessagePortLike } from "./port-adapter.js";
import type { SpawnFn } from "./ports.js";
import { createPtyService, type PtyService, type PtyServiceOptions } from "./service.js";

/**
 * The pty utility process entry logic (ticket pty-adapter, `docs/design/pty-process.md` "Channel transport"). The overlay file
 * `vs/axis/pty/node/axisPtyMain.ts` only hands this function the real `process`, `process.parentPort` and a `SpawnFn` over Code
 * OSS's own node-pty; everything that can be tested without Electron is here.
 *
 * Only main can write `parentPort`. Main sends exactly two kinds of message, each carrying exactly ONE port:
 *   `{ type: "pty-control", generation }` the daemon's control channel; the newest generation wins (OS-3h, below). The legacy
 *                                         `{ type: "pty-control" }` without a generation (the Code OSS shell) is adopted too, unacknowledged.
 *   `{ type: "pty-data", conn: <name> }` one renderer data connection, named `conn` by main (the name the `grant` message uses)
 * Anything else (another shape, no port, several ports, a bad name) is dropped and every port in it closed. Terminal ids, spawn and
 * kill authority and the per-connection binding are the service's; nothing is decided here.
 *
 * Fails closed (exit 78, before any port is served) when the file was not started as a utility process, with a debugger flag, any
 * `execArgv` or `NODE_OPTIONS`.
 *
 * Git and forge programs (PV-X1a, `docs/design/pty-exec-node.md` §5 and §6.2): main puts `AXIS_PTY_GIT`, `AXIS_PTY_GH` and
 * `AXIS_PTY_SCRATCH` in this process's environment at fork. With `AXIS_PTY_GIT` set the git exec path (exec, scratch, hook, push)
 * runs through `createNodeExec({gitPath})`; unset, it stays off (every exec answers `spawn_failed`) and terminals still work. With
 * `AXIS_PTY_GH` set, `forge-list` (PV-D2) runs that gh through its own `createNodeExec({ghPath})`; unset, every `forge-list` answers
 * `spawn_missing`. Either program needs `AXIS_PTY_SCRATCH`. A value
 * that is set and wrong refuses the start: a relative, symlinked, group- or world-writable or non-executable program, a scratch directory that is missing, a symlink, not
 * this user's, or open to group or others. `AXIS_*` names never reach a child (PTY-5 drops them). Windows: ignored (no exec there;
 * every `forge-list` answers `unsupported_platform`).
 */
export const PTY_EXIT_REFUSED = 78;

/**
 * The acknowledged control hand-over (OS-3h, `docs/design/own-shell-main-seam.md` §3a). On `pty-control` with generation G (a safe
 * integer above every generation seen), this process adopts G (the service retires the channel it held: latest wins) and answers
 * `{ type: "pty-control-adopted", generation: G }` on its parent port. Portless messages from main:
 *   `{ type: "pty-control-confirmed", generation }` both ends adopted G: keep it;
 *   `{ type: "pty-control-close", generation }`     close G if held; always answered `{ type: "pty-control-closed", generation }`.
 * A G that is not confirmed within PTY_CONTROL_EXPIRY_MS closes itself, so a channel cannot outlive a main that lost track of it.
 * A generation at or below one already seen is closed unadopted, with no answer.
 */
export const PTY_CONTROL_EXPIRY_MS = 10_000;
const isGeneration = (g: unknown): g is number => typeof g === "number" && Number.isSafeInteger(g) && g >= 1;

export interface PtyEntryTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const MAX_CONN_CHARS = 128;
const DEBUG_FLAG = /^--(?:inspect|debug|remote-debugging)/i;

export interface PtyParentPortLike {
  on(event: "message", listener: (event: { data: unknown; ports?: readonly MessagePortLike[] }) => void): unknown;
  /** Electron's `process.parentPort.postMessage`: the hand-over's acknowledgements. Without it nothing is acknowledged. */
  postMessage?(message: unknown): void;
  removeListener(event: "message", listener: (event: { data: unknown; ports?: readonly MessagePortLike[] }) => void): unknown;
}

export interface PtyEntryProcess {
  exit(code?: number): unknown;
  on(event: "SIGTERM" | "SIGINT" | "SIGUSR1" | "exit", listener: () => void): unknown;
  removeListener(event: "SIGTERM" | "SIGINT" | "exit", listener: () => void): unknown;
}

export interface PtyEntryDeps {
  readonly parentPort: PtyParentPortLike | undefined;
  readonly process: PtyEntryProcess;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly execArgv: readonly string[];
  readonly spawn: SpawnFn;
  readonly platform?: NodeJS.Platform;
  /** This process's uid (the endpoint directory's required owner). Default `process.getuid()`. */
  readonly uid?: number;
  /** One closed line per refusal. */
  readonly stderr: (line: string) => void;
  /** The control expiry timer. Default `setTimeout`. */
  readonly timers?: PtyEntryTimers;
}

export { PTY_ENV_GH, PTY_ENV_GIT, PTY_ENV_SCRATCH, readPtyExecConfig, type PtyExecConfig } from "./config.js";

export interface PtyEntryHandle {
  readonly service: PtyService | undefined;
  /** Kills every terminal, closes every channel, removes the listeners. Idempotent. */
  dispose(): void;
}

const closeAll = (ports: readonly MessagePortLike[]): void => {
  for (const p of ports) {
    try {
      p.close();
    } catch {
      /* already closed */
    }
  }
};

/** The one closed line the entry writes when SIGUSR1 arrives (the inspector stays closed). */
export const DEBUG_SIGNAL_LINE = "axis.pty ignored SIGUSR1: the inspector stays closed";
/**
 * The one `execArgv` the pty process may be forked with: the flag that stops SIGUSR1 from opening the inspector under plain Node.
 * Electron's utility process ignores it, so there the guard in `signal-guard.ts` is the control.
 */
export const EXEC_ARGV_ALLOWED = "--disable-sigusr1";

export function runPtyEntry(deps: PtyEntryDeps): PtyEntryHandle {
  // Audit C M1: SIGUSR1 would open Node's unauthenticated inspector on 127.0.0.1:9229, from which any local user could read
  // this process's heap. Under Electron's utility process `--disable-sigusr1` is not honoured, so a listener is the control:
  // the file the shell forks installs a silent one through `signal-guard.ts`, its one static import, before this graph loads.
  // This one writes the closed line. Installed first, on every path, and never removed, not even by `dispose`: with no
  // listener the signal's default applies again.
  let signalled = false;
  deps.process.on("SIGUSR1", () => {
    if (signalled) return;
    signalled = true;
    try {
      deps.stderr(DEBUG_SIGNAL_LINE);
    } catch {
      /* a failing log line never changes the outcome */
    }
  });
  const refuse = (reason: string): PtyEntryHandle => {
    try {
      deps.stderr(`axis.pty refused to start: ${reason}`);
    } catch {
      /* a failing log line never changes the outcome */
    }
    deps.process.exit(PTY_EXIT_REFUSED);
    return { service: undefined, dispose: () => undefined };
  };
  if (deps.parentPort === undefined || typeof deps.parentPort.on !== "function") return refuse("not_utility_process");
  if (deps.execArgv.some((a) => DEBUG_FLAG.test(a))) return refuse("debug_flag_refused");
  // The one allowed argument is the flag that keeps the inspector closed, alone (audit C M1).
  if (!(deps.execArgv.length === 0 || (deps.execArgv.length === 1 && deps.execArgv[0] === EXEC_ARGV_ALLOWED))) return refuse("exec_args_refused");
  const nodeOptions = deps.env["NODE_OPTIONS"];
  if (nodeOptions !== undefined && nodeOptions !== "") return refuse("node_options_refused");

  const platform = deps.platform ?? process.platform;
  const execConfig = platform === "win32" ? {} : readPtyExecConfig(deps.env);
  if (typeof execConfig === "string") return refuse(execConfig);

  const parentPort = deps.parentPort;
  let git: PtyServiceOptions["git"];
  let forge: PtyServiceOptions["forge"];
  const baseEnv: Record<string, string | undefined> = { ...deps.env };
  for (const k of [PTY_ENV_GIT, PTY_ENV_GH, PTY_ENV_SCRATCH]) delete baseEnv[k];
  if (execConfig.gitPath !== undefined && execConfig.scratchParent !== undefined) {
    // One exec function per consumer (§1): git's can start only the git it was given.
    git = { exec: createNodeExec(new Set([execConfig.gitPath]), platform), gitPath: execConfig.gitPath, hooksOff: "/dev/null", scratchParent: execConfig.scratchParent, baseEnv };
  }
  if (platform === "win32") {
    // PV-D2: no process group to kill (PV-X1w), so every `forge-list` is `unsupported_platform` and nothing is created or run.
    forge = { exec: createNodeExec(new Set(), platform), ghPath: undefined, scratchParent: "", baseEnv: {} };
  } else if (execConfig.ghPath !== undefined && execConfig.scratchParent !== undefined) {
    // PV-D2 slice 2: the forge path's own exec function, which can start only the gh it was given (never git).
    forge = { exec: createNodeExec(new Set([execConfig.ghPath]), platform), ghPath: execConfig.ghPath, scratchParent: execConfig.scratchParent, baseEnv };
  }
  // PV-M7 slice 2: the CLI endpoint listener's configuration on Unix (the runtime directory, the platform, this process's uid).
  // Nothing is created here: the listener opens one socket only when the daemon asks for one endpoint in a spawn, which it does
  // only while the user's switch is on. Windows has none (decision 8), and an undefined directory or uid configures none.
  const uid = deps.uid ?? process.getuid?.();
  const dir = uid === undefined ? undefined : defaultEndpointDir(deps.env, platform, uid);
  const endpoints: EndpointHostConfig | undefined = platform === "win32" || uid === undefined || dir === undefined ? undefined : { dir, platform, uid };
  const service = createPtyService({ spawn: deps.spawn, ...(endpoints === undefined ? {} : { messagesEndpoints: endpoints }), ...(deps.platform === undefined ? {} : { platform: deps.platform }), ...(git === undefined ? {} : { git }), ...(forge === undefined ? {} : { forge }) });
  let disposed = false;
  const timers: PtyEntryTimers = deps.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  // The control generation this process holds (OS-3h). `generation` is undefined for a legacy, unacknowledged channel.
  let held: { readonly generation: number | undefined; readonly served: { dispose(): void }; readonly port: MessagePortLike; confirmed: boolean; expiry: unknown } | undefined;
  let highest = 0;
  const answer = (message: { type: string; generation: number }): void => {
    try {
      parentPort.postMessage?.(message);
    } catch {
      // main is gone: nothing to tell
    }
  };
  const release = (): void => {
    const h = held;
    held = undefined;
    if (h === undefined) return;
    if (h.expiry !== undefined) timers.clear(h.expiry);
    h.served.dispose();
    try {
      h.port.close();
    } catch {
      // already closed
    }
  };
  const adopt = (port: MessagePortLike, generation: number | undefined): void => {
    const served = service.serveControl(adaptMessagePort(port, { shape: "electron" }));
    if (held !== undefined && held.expiry !== undefined) timers.clear(held.expiry);
    held = { generation, served, port, confirmed: generation === undefined, expiry: undefined };
    if (generation === undefined) return;
    const mine = held;
    mine.expiry = timers.set(() => {
      if (held === mine && !mine.confirmed) release();
    }, PTY_CONTROL_EXPIRY_MS);
    answer({ type: "pty-control-adopted", generation });
  };
  const onControlNote = (data: object, kind: unknown): boolean => {
    const generation = (data as { generation?: unknown }).generation;
    if ((kind !== "pty-control-confirmed" && kind !== "pty-control-close") || Object.keys(data).length !== 2 || !isGeneration(generation)) return false;
    if (kind === "pty-control-confirmed") {
      if (held?.generation === generation && !held.confirmed) {
        held.confirmed = true;
        if (held.expiry !== undefined) timers.clear(held.expiry);
        held.expiry = undefined;
      }
    } else {
      if (held?.generation === generation) release();
      answer({ type: "pty-control-closed", generation });
    }
    return true;
  };

  const onMessage = (event: { data: unknown; ports?: readonly MessagePortLike[] }): void => {
    const ports = Array.isArray(event.ports) ? event.ports : [];
    const data = event.data;
    const kind = typeof data === "object" && data !== null ? (data as { type?: unknown }).type : undefined;
    const conn = typeof data === "object" && data !== null ? (data as { conn?: unknown }).conn : undefined;
    if (!disposed && ports.length === 0 && typeof data === "object" && data !== null && onControlNote(data, kind)) return;
    const only = ports.length === 1 ? ports[0] : undefined;
    if (disposed || only === undefined) return closeAll(ports);
    const keys = kind === "pty-control" ? Object.keys(data as object) : [];
    const generation = (data as { generation?: unknown } | null)?.generation;
    if (kind === "pty-control" && keys.length === 1) {
      adopt(only, undefined);
    } else if (kind === "pty-control" && keys.length === 2 && isGeneration(generation)) {
      if (generation <= highest) return closeAll(ports);
      highest = generation;
      adopt(only, generation);
    } else if (kind === "pty-data" && typeof conn === "string" && conn.length >= 1 && conn.length <= MAX_CONN_CHARS && Object.keys(data as object).length === 2) {
      service.serveData(adaptMessagePort(only, { shape: "electron" }), conn);
    } else {
      closeAll(ports);
    }
  };
  // Main ending this process, or a signal: no terminal may outlive the service that could signal its group.
  const end = (): void => dispose();
  const terminate = (): void => {
    dispose();
    deps.process.exit(0);
  };
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    parentPort.removeListener("message", onMessage);
    if (held?.expiry !== undefined) timers.clear(held.expiry);
    deps.process.removeListener("SIGTERM", terminate);
    deps.process.removeListener("SIGINT", terminate);
    deps.process.removeListener("exit", end);
    service.dispose();
  }
  parentPort.on("message", onMessage);
  deps.process.on("SIGTERM", terminate);
  deps.process.on("SIGINT", terminate);
  deps.process.on("exit", end);
  return { service, dispose };
}
