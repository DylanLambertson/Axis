// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { constants } from "node:os";
import type { Disposable, PtyChild, PtyExit, SpawnFn } from "./ports.js";

/** The part of node-pty's `IPty` the pty process uses. Code OSS's own copy satisfies it; nothing here imports it. */
export interface NodePtyLike {
  readonly pid: number;
  readonly onData: (listener: (data: string) => void) => { dispose(): void };
  readonly onExit: (listener: (exit: { exitCode: number; signal?: number | undefined }) => void) => { dispose(): void };
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
}

export interface NodePtySpawnOptions {
  readonly name: string;
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string;
  readonly env: { [key: string]: string };
  readonly encoding: "utf8";
  /** Always false: with it on, a user typing the XOFF character would pause the child (node-pty "flow control", EXPERIMENTAL). */
  readonly handleFlowControl: false;
}

/** node-pty's exported `spawn`, called directly (not upstream's `PtyService`/`TerminalProcess`, which add `VSCODE_*` and a nonce: PTY-6). */
export type NodePtySpawn = (file: string, args: string[], options: NodePtySpawnOptions) => NodePtyLike;

const DEFAULT_TERM = "xterm-256color";

const signalNames = new Map<number, string>(Object.entries(constants.signals).map(([name, number]) => [number, name]));

/** node-pty reports a signal as a number (0 or absent: none). */
export function signalName(signal: number | undefined): string | null {
  return signal === undefined || signal === 0 ? null : (signalNames.get(signal) ?? `SIG${signal}`);
}

/**
 * The shipped `SpawnFn`. node-pty forks the child with `setsid` on POSIX, so the group leader is the child and `pgid` equals `pid`
 * (the service refuses anything else). The environment is passed as given; node-pty itself adds `PWD` (the cwd) and, when `TERM` is
 * missing, `TERM`. Windows has no job object through ConPTY (design doc, decision 1), so a spawn there fails (`spawn_failed`).
 */
export function createNodePtySpawn(spawnPty: NodePtySpawn, platform: string = process.platform): SpawnFn {
  return (request) => {
    if (platform === "win32") throw new Error("unsupported platform");
    const [file, ...args] = request.argv;
    if (file === undefined) throw new Error("empty argv");
    const pty = spawnPty(file, args, {
      name: request.env["TERM"] ?? DEFAULT_TERM,
      cols: request.cols,
      rows: request.rows,
      cwd: request.cwd,
      env: { ...request.env },
      encoding: "utf8",
      handleFlowControl: false,
    });
    const child: PtyChild = {
      pid: pty.pid,
      group: { kind: "pgid", pgid: pty.pid },
      write: (data) => pty.write(data),
      resize: (cols, rows) => pty.resize(cols, rows),
      kill: (signal) => pty.kill(signal),
      pause: () => pty.pause(),
      resume: () => pty.resume(),
      onData: (listener): Disposable => pty.onData(listener),
      onExit: (listener): Disposable =>
        pty.onExit((exit) => {
          const reported: PtyExit = { exitCode: exit.exitCode, signal: signalName(exit.signal) };
          listener(reported);
        }),
    };
    return child;
  };
}
