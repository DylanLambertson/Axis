// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { RelayIn, RelayOut } from "../messages/endpoint.js";
import type { ForgeListRequest, ForgeReply } from "@axis/protocol";

/**
 * The Axis pty process, as `@axis/runs` uses it (same shapes as its `PtyPort`, repeated here because only
 * `src/bindings/*.ts` may import that package). The CLI agent's output goes to the user's terminal and never into
 * the daemon, which only sees status.
 */
export type PtySignal = "SIGINT" | "SIGTERM" | "SIGKILL";

export interface PtySpawn {
  readonly runId: string;
  /** `argv[0]` is the absolute path Axis resolved; the pty never searches PATH or the cwd. */
  readonly argv: readonly string[];
  readonly cwd: string;
  /** The PTY-5 environment, used as given. */
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
  /** PV-M6: the run's messaging endpoint (the daemon's id and token), set by the daemon host only; the supervisor never sets it. */
  readonly messagesEndpoint?: { readonly endpoint: string; readonly token: string };
}

export interface PtyExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export interface PtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal: PtySignal): void;
  /**
   * True while any process of the run's process group exists (POSIX: the group id answers `kill(-pgid, 0)`; Windows: the job
   * is not empty). The leader's exit does not end it: a CLI can leave children behind. Axis must not restore, finalise or
   * remove a workspace while this is true. It may throw: a throw counts as alive (fail closed).
   */
  groupAlive(): boolean;
  onData(listener: (chunk: string) => void): { dispose(): void };
  onExit(listener: (exit: PtyExit) => void): { dispose(): void };
}

export interface PtyPort {
  spawn(spec: PtySpawn): Promise<PtyHandle>;
}

/** DC-3a: a handle that names its terminal in the pty process (`pty_` and 32 hex characters), so it can be granted and revoked. */
export interface PtyTerminalHandle extends PtyHandle {
  readonly terminalId: string;
}

/** The closed spawn failure codes of `@axis/pty-process` (`PtySpawnFailure`), repeated here. */
export type PtySpawnFailureCode = "timeout" | "channel_closed" | "capacity" | "env_denied" | "bad_group" | "spawn_failed" | "no_control" | "bad_bind" | "hook_changed" | "bad_argv" | "remote_refused" | "endpoint_unavailable";

/**
 * What became of a spawn after it rejected with `timeout` (`LateSpawn` of `@axis/pty-process`): `spawned`, the group exists, already
 * killed by the port and tracked (its handle answers `groupAlive` until it is gone); `failed`, the pty process's definitive no-spawn.
 */
export type PtyLateSpawn = { readonly kind: "spawned"; readonly handle: PtyTerminalHandle } | { readonly kind: "failed"; readonly code: PtySpawnFailureCode };

/**
 * DC-3a's terminal port (`terminals-contract.md` section 8), all four parts or none:
 * - `spawn`, giving a handle that carries its `terminalId`, and hearing the late outcome of a spawn that timed out (`onLate`);
 * - `grant(terminalId, conn)`: only data connection `conn` may attach;
 * - `revoke(terminalId)`: no data connection may reach it again (false when the port is closed);
 * - definitive outcomes: a rejection's `definitive` is true only when no process can appear for it (`isDefinitiveSpawnFailure`).
 * `lateSpawnReports` marks a port whose rejections carry `definitive` and whose `onLate` is honoured.
 */
export interface PtyTerminalPort {
  /** `onLate` is optional on the port (the runs call `spawn(spec)` on the same port); the terminal service always passes it. */
  spawn(spec: PtySpawn, onLate?: (late: PtyLateSpawn) => void): Promise<PtyTerminalHandle>;
  grant(terminalId: string, conn: string): void;
  revoke(terminalId: string): boolean;
  readonly lateSpawnReports: true;
}

/** True only for a spawn rejection that says no process can appear (`PtySpawnError.definitive`); anything else is unknown. */
export function isDefinitiveSpawnFailure(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { definitive?: unknown }).definitive === true;
}

/**
 * The messaging endpoint relay over the pty control channel (PV-M6, ADR 0007 decision 7.1): the relayed messages in, the
 * daemon's answers out. The envelopes are `@axis/pty-process`'s `relayInbound` / `relayOutbound`, parsed by the port.
 */
export interface PtyRelayPort {
  onRelay(handler: (msg: RelayIn) => void): { dispose(): void };
  relay(msg: RelayOut): boolean;
}

/**
 * A plain, bounded git command in the pty process (the `exec` message, docs/design/daemon-host-hooks.md §4.1), repeated from
 * `@axis/pty-process` (`PtyExecCall`, `PtyExecOutcome`; `test/types/pty-exec-port.test.ts` compares both directions). `repo`
 * is what the service emits as `--git-dir`/`--work-tree`; the argv carries no global option. Only `createPtyGitRunner`
 * (`src/bindings/pty-git.ts`) builds one.
 */
export interface PtyExecCall {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly maxOutput: number;
  readonly repo: { readonly gitDir: string; readonly workTree: string };
}

export interface PtyExecOutcome {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

/** The pty process's `exec`. A rejection carries at most a closed `code` (`PtyExecError` of `@axis/pty-process`). */
export interface PtyExecPort {
  exec(call: PtyExecCall): Promise<PtyExecOutcome>;
}

/**
 * `git push` of the one pinned refspec as a terminal-bound run in the pty process (the `push` message, H9-hooks §5.2, S4 part 1),
 * repeated from `@axis/pty-process` (`PtyPushCall`; `test/types/pty-exec-port.test.ts` compares both directions). The pty process
 * builds the argv, the pins and the environment; `env` carries only its allow-list. Only `createPtyGitRunner` builds one.
 */
export interface PtyPushCall {
  readonly runId: string;
  readonly repo: { readonly gitDir: string; readonly workTree: string };
  readonly remote: string;
  readonly refspec: string;
  /** git-ops' `pushUrlsDigest` of the push URLs it read; the pty process refuses (`remote_refused`) when its own read differs. */
  readonly pushUrls: string;
  readonly env: Readonly<Record<string, string>>;
  /** The configuration and ssh variables the host validated, `null` for unset; the pty process refuses a push whose own differ. */
  readonly expectEnv: Readonly<Record<"HOME" | "XDG_CONFIG_HOME" | "GIT_CONFIG" | "GIT_CONFIG_GLOBAL" | "GIT_CONFIG_SYSTEM" | "GIT_CONFIG_NOSYSTEM" | "GIT_SSH" | "GIT_SSH_COMMAND" | "GIT_SSH_VARIANT" | "GIT_PROXY_COMMAND", string | null>>;
  readonly cols: number;
  readonly rows: number;
}

/** The pty process's `push`. The handle reports the exit status only; a rejection carries at most a closed `code`. */
export interface PtyPushPort {
  push(call: PtyPushCall): Promise<PtyHandle>;
}

/**
 * The pty process's `forge-list` (PV-D2 slice 2, docs/design/forge-pr-list.md §1), repeated from `@axis/pty-process`
 * (`PtyProcessPort.forgeList`; `test/types/pty-exec-port.test.ts` compares it). The request is the shared `@axis/protocol`
 * schema's; the reply comes back parsed by the shared reply schema, or `undefined` when it failed it. A rejection carries at most
 * a closed `code`.
 */
export interface PtyForgePort {
  forgeList(request: ForgeListRequest): Promise<ForgeReply | undefined>;
}
