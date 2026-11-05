// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/** The exact command to run, already resolved by `@axis/pty-policy` (PATH only, never the worktree). */
export interface CliCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The PTY-5 filtered environment, in full. The process gets nothing else. */
  readonly env: Readonly<Record<string, string>>;
}

export interface CliExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface CliProcess {
  readonly pid: number;
  /** Settles once, when the process ends. Never rejects. */
  readonly exited: Promise<CliExit>;
  /** Ask the process (and its group) to stop. Idempotent. */
  kill(): void;
}

/**
 * Starts CLI agent processes. Status only: the daemon never receives the process output (it goes to the user's
 * terminal), so nothing here can carry a secret into the host.
 */
export interface CliProcessHost {
  spawn(command: CliCommand, signal: AbortSignal): Promise<CliProcess>;
}
