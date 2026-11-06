// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { adaptMessagePort, type MessagePortLike } from "./port-adapter.js";
import type { SpawnFn } from "./ports.js";
import { createPtyService, type PtyService } from "./service.js";

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

  const parentPort = deps.parentPort;
  const service = createPtyService({ spawn: deps.spawn, ...(deps.platform === undefined ? {} : { platform: deps.platform }) });
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
