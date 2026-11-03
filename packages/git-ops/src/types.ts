// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
export type GitContext = "pty" | "daemon";
export type Env = Readonly<Record<string, string | undefined>>;

export interface GitRunRequest {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  /** Written to stdin when present (commit messages). */
  readonly stdin?: string;
  /**
   * Where the process runs. "daemon": hooks must be off (guarded). "pty": the Axis pty process, which holds
   * no secrets and may run repository hooks when policy allows.
   */
  readonly context: GitContext;
}

export interface GitRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitRunner {
  run(req: GitRunRequest): Promise<GitRunResult>;
}

/** The registered worktree, from the journal: never discovered from the directory (threat model GIT-4). */
export interface WorktreeRef {
  /** Absolute, normalised work tree path. */
  readonly workTree: string;
  /** Absolute, normalised git directory of this worktree. */
  readonly gitDir: string;
}

export interface SecretFinding {
  readonly rule: string;
  readonly path?: string;
  readonly line?: number;
  /** The outgoing commit whose patch matched. Set by Axis, not by the scanner. */
  readonly commit?: string;
}

export interface ScanMeta {
  readonly worktree: WorktreeRef;
  /** The patch was cut at the size limit. */
  readonly truncated: boolean;
  /** The commit whose patch this is. The scanner is called once per outgoing commit. */
  readonly commit: string;
}

/** PSH-1 hook point: scan the patch of one outgoing commit. Findings must never contain the secret itself. */
export type SecretScanner = (diff: string, meta: ScanMeta) => Promise<readonly SecretFinding[]>;

export interface GitOpsDeps {
  readonly runner: GitRunner;
  /** daemon: GIT-ENV-1 environment. pty: the PTY-5 environment (credentials, signing). */
  readonly env: { readonly daemon: Env; readonly pty: Env };
  /** axis.git.runHooks. When false, commit and push add --no-verify and an empty hooks path. */
  readonly runHooks: boolean;
  /** Gate 1a/L24: Axis commit and push are refused while a CLI run is active in the workspace. */
  readonly isCliRunActive: (worktree: WorktreeRef) => boolean | Promise<boolean>;
  /** GIT-SNAP-1 re-take: throws when the common dir drifted from the acknowledged baseline. */
  readonly assertNoDrift: (worktree: WorktreeRef) => Promise<void>;
  readonly scanner?: SecretScanner;
  readonly scanMode?: "warn" | "refuse";
  /** Windows only: an empty directory used as core.hooksPath (POSIX uses /dev/null). */
  readonly emptyHooksDir?: string;
  readonly platform?: NodeJS.Platform;
}
