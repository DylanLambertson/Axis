// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The pty service's options and interface (split from service.ts, which re-exports them).
import type { ForgeListConfig } from "./forge-list.js";
import type { GitExecConfig } from "./git-exec.js";
import type { EndpointHostConfig } from "./endpoint-host.js";
import type { FlowLimits } from "./flow.js";
import type { Channel, Clock, Disposable, ProcessOps, SpawnFn } from "./ports.js";

export interface PtyServiceOptions {
  /** Starts a child in its own session or job. In the shipped entry this is the native pty binding. */
  readonly spawn: SpawnFn;
  readonly ops?: ProcessOps;
  /** Terminal ids are `pty_` plus 32 hex characters of this. Default: node:crypto. */
  readonly randomBytes?: (n: number) => Uint8Array;
  /** Live terminals (a leader or a group still running). Default 64. */
  readonly maxTerminals?: number;
  /** Decides what an absolute path is for `argv[0]` and `cwd`. Default: this process's platform. */
  readonly platform?: NodeJS.Platform;
  /** `exec`, `scratch-*` and `hook` (H9-hooks). Absent: every such message is refused. */
  readonly git?: GitExecConfig;
  /** `forge-list` (PV-D2): `gh` through its own exec function. Absent: every `forge-list` answers `spawn_missing`. */
  readonly forge?: ForgeListConfig;
  /** Times each exec. Default: the system clock. */
  readonly clock?: Clock;
  /** Output flow-control bounds per terminal (characters in flight to the viewer). Default 1 MiB pause, 256 KiB resume, 4 MiB drop. */
  readonly flow?: FlowLimits;
  /** Bytes of unconsumed input per terminal and in the whole process before further input is refused (PTY-4). Default 1 MiB and 8 MiB. */
  readonly input?: Partial<{ terminal: number; process: number; entriesTerminal: number; entriesProcess: number }>;
  /** Distinct data-connection names served over the life of the service; past this a new name is refused. Default 65536. */
  readonly maxConnNames?: number;
  /** PV-M6: the messaging endpoint listener's runtime directory. Absent (the default): a spawn asking for an endpoint is refused. */
  readonly messagesEndpoints?: EndpointHostConfig;
}

export interface PtyService {
  /** The one channel that may spawn and signal (the daemon's). A second control channel is refused. */
  serveControl(channel: Channel): Disposable;
  /**
   * A renderer data channel, named `conn` by whoever brokered it. It can attach only to a terminal the control channel
   * `grant`ed to `conn`, then write, resize and read output. A second channel with the same `conn` is closed.
   */
  serveData(channel: Channel, conn: string): Disposable;
  /** SIGKILLs the process group of every terminal, closes the channels, releases the listeners and settles. Idempotent. */
  dispose(): void;
}
