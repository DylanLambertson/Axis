// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The ports the run supervisor is built on. Nothing here touches Node globals, so every port has a fake.

export interface Disposable {
  dispose(): void;
}

/** The three signals of the stop ladder (threat model PTY-4). The port sends them to the process group. */
export type PtySignal = "SIGINT" | "SIGTERM" | "SIGKILL";

export interface PtySpawn {
  /** The run id, so the pty process can issue its terminal id for it. */
  readonly runId: string;
  /** `argv[0]` is the absolute path Axis resolved. The pty never searches PATH or the cwd. */
  readonly argv: readonly string[];
  readonly cwd: string;
  /** The PTY-5 environment. The port must use it as given and add nothing, shell integration included. */
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
}

export interface PtyExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

/**
 * One live pty. Every method may throw and every callback may fire at any time, including synchronously
 * inside `onExit` or `onData`; the supervisor treats a port as untrusted for liveness and bounds.
 */
export interface PtyHandle {
  /** Part of the port contract. The supervisor never calls it: keystrokes bypass the daemon and Axis never answers a CLI prompt. */
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal: PtySignal): void;
  onData(listener: (chunk: string) => void): Disposable;
  onExit(listener: (exit: PtyExit) => void): Disposable;
}

export interface PtyPort {
  spawn(spec: PtySpawn): Promise<PtyHandle>;
}

export type TimerId = unknown;

/** Every timer in this package goes through a clock, so tests can drive time and count what is left behind. */
export interface Clock {
  /** Milliseconds, monotonic enough for intervals. Attestations are stamped with the same clock. */
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerId;
  clearTimeout(id: TimerId): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** A registered worktree. Same shape as `WorktreeRef` in `@axis/git-ops`. */
export interface RunWorktree {
  /** Absolute, normalised work tree path. */
  readonly workTree: string;
  /** Absolute, normalised git directory of this worktree. */
  readonly gitDir: string;
}

export interface WorktreeLocator {
  /** The journal's registered worktree for this workspace, already realpath-checked by the daemon (DMN-2). */
  locate(workspaceId: string): Promise<RunWorktree>;
}

export interface SnapshotContext {
  readonly runId: string;
  readonly workspaceId: string;
  readonly worktree: RunWorktree;
}

/** GIT-SNAP-1 around a run. `before` throwing or timing out refuses the launch; `after` is recorded, never fatal. */
export interface RunSnapshotter {
  before(ctx: SnapshotContext): Promise<void>;
  after(ctx: SnapshotContext): Promise<{ readonly drift: boolean }>;
}

/** The resolved shell environment main passed to the daemon: the input of PTY-5, never `process.env` of the daemon. */
export type EnvSource = () => Readonly<Record<string, string | undefined>>;
