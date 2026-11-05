// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

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
