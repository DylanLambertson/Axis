// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { accessSync, constants, lstatSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
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
 *   `{ type: "pty-control" }`            the daemon's control channel (one at a time; a second is closed by the service)
 *   `{ type: "pty-data", conn: <name> }` one renderer data connection, named `conn` by main (the name the `grant` message uses)
 * Anything else (another shape, no port, several ports, a bad name) is dropped and every port in it closed. Terminal ids, spawn and
 * kill authority and the per-connection binding are the service's; nothing is decided here.
 *
 * Fails closed (exit 78, before any port is served) when the file was not started as a utility process, with a debugger flag, any
 * `execArgv` or `NODE_OPTIONS`.
 *
 * Git and forge programs (PV-X1a, `docs/design/pty-exec-node.md` §5 and §6.2): main puts `AXIS_PTY_GIT`, `AXIS_PTY_GH` and
 * `AXIS_PTY_SCRATCH` in this process's environment at fork. With `AXIS_PTY_GIT` set the git exec path (exec, scratch, hook, push)
 * runs through `createNodeExec({gitPath})`; unset, it stays off (every exec answers `spawn_failed`) and terminals still work. A value
 * that is set and wrong refuses the start: a relative or non-executable program, a scratch directory that is missing, a symlink, not
 * this user's, or open to group or others. `AXIS_*` names never reach a child (PTY-5 drops them). Windows: ignored (no exec there).
 */
export const PTY_EXIT_REFUSED = 78;
const MAX_CONN_CHARS = 128;
const DEBUG_FLAG = /^--(?:inspect|debug|remote-debugging)/i;

export interface PtyParentPortLike {
  on(event: "message", listener: (event: { data: unknown; ports?: readonly MessagePortLike[] }) => void): unknown;
  removeListener(event: "message", listener: (event: { data: unknown; ports?: readonly MessagePortLike[] }) => void): unknown;
}

export interface PtyEntryProcess {
  exit(code?: number): unknown;
  on(event: "SIGTERM" | "SIGINT" | "exit", listener: () => void): unknown;
  removeListener(event: "SIGTERM" | "SIGINT" | "exit", listener: () => void): unknown;
}

export interface PtyEntryDeps {
  readonly parentPort: PtyParentPortLike | undefined;
  readonly process: PtyEntryProcess;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly execArgv: readonly string[];
  readonly spawn: SpawnFn;
  readonly platform?: NodeJS.Platform;
  /** One closed line per refusal. */
  readonly stderr: (line: string) => void;
}

/** The names main hands the programs and the scratch directory over in (§6.2). */
export const PTY_ENV_GIT = "AXIS_PTY_GIT";
export const PTY_ENV_GH = "AXIS_PTY_GH";
export const PTY_ENV_SCRATCH = "AXIS_PTY_SCRATCH";

/** The exec configuration the entry read from its environment, or the closed reason it refuses. */
export interface PtyExecConfig {
  readonly gitPath?: string;
  readonly ghPath?: string;
  readonly scratchParent?: string;
}

const programOk = (p: string): boolean => {
  if (!isAbsolute(p) || p.includes("\0")) return false;
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const scratchOk = (p: string): boolean => {
  if (!isAbsolute(p) || p.includes("\0")) return false;
  try {
    const st = lstatSync(p);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    return st.isDirectory() && (st.mode & 0o077) === 0 && (uid === undefined || st.uid === uid);
  } catch {
    return false;
  }
};

/** Reads and checks the hand-over names. Unset names stay unset; a set name that fails its check is a refusal reason. */
export function readPtyExecConfig(env: Readonly<Record<string, string | undefined>>): PtyExecConfig | string {
  const git = env[PTY_ENV_GIT];
  const gh = env[PTY_ENV_GH];
  const scratch = env[PTY_ENV_SCRATCH];
  if (git !== undefined && !programOk(git)) return "git_path_refused";
  if (gh !== undefined && !programOk(gh)) return "gh_path_refused";
  if (scratch !== undefined && !scratchOk(scratch)) return "scratch_refused";
  if (git !== undefined && scratch === undefined) return "scratch_refused";
  return { ...(git === undefined ? {} : { gitPath: git }), ...(gh === undefined ? {} : { ghPath: gh }), ...(scratch === undefined ? {} : { scratchParent: scratch }) };
}

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

export function runPtyEntry(deps: PtyEntryDeps): PtyEntryHandle {
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
  if (deps.execArgv.length > 0) return refuse("exec_args_refused");
  const nodeOptions = deps.env["NODE_OPTIONS"];
  if (nodeOptions !== undefined && nodeOptions !== "") return refuse("node_options_refused");

  const platform = deps.platform ?? process.platform;
  const execConfig = platform === "win32" ? {} : readPtyExecConfig(deps.env);
  if (typeof execConfig === "string") return refuse(execConfig);

  const parentPort = deps.parentPort;
  let git: PtyServiceOptions["git"];
  if (execConfig.gitPath !== undefined && execConfig.scratchParent !== undefined) {
    // One exec function per consumer (§1): git's can start only the git it was given.
    const baseEnv: Record<string, string | undefined> = { ...deps.env };
    for (const k of [PTY_ENV_GIT, PTY_ENV_GH, PTY_ENV_SCRATCH]) delete baseEnv[k];
    git = { exec: createNodeExec(new Set([execConfig.gitPath]), platform), gitPath: execConfig.gitPath, hooksOff: "/dev/null", scratchParent: execConfig.scratchParent, baseEnv };
  }
  const service = createPtyService({ spawn: deps.spawn, ...(deps.platform === undefined ? {} : { platform: deps.platform }), ...(git === undefined ? {} : { git }) });
  let disposed = false;

  const onMessage = (event: { data: unknown; ports?: readonly MessagePortLike[] }): void => {
    const ports = Array.isArray(event.ports) ? event.ports : [];
    const data = event.data;
    const kind = typeof data === "object" && data !== null ? (data as { type?: unknown }).type : undefined;
    const conn = typeof data === "object" && data !== null ? (data as { conn?: unknown }).conn : undefined;
    const only = ports.length === 1 ? ports[0] : undefined;
    if (disposed || only === undefined) return closeAll(ports);
    if (kind === "pty-control" && Object.keys(data as object).length === 1) {
      service.serveControl(adaptMessagePort(only, { shape: "electron" }));
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
