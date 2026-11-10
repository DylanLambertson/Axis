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
