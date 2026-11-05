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
  /**
   * Return stdout with one character per byte (latin1) instead of decoding it as UTF-8, so the bytes of a commit object
   * survive intact. A runner that honours this sets `raw: true` on the result; the secret scan fails closed
   * (E_UNAVAILABLE) when it asked for raw output and the result does not say it got it.
   */
  readonly raw?: boolean;
}

export interface GitRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout was cut at the runner's output limit. A caller that needs all of it (the secret scan) must fail closed. */
  readonly truncated?: boolean;
  /** stdout holds one character per byte because the request asked for `raw`. */
  readonly raw?: boolean;
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
  /** Paths git treats as binary in this commit (a NUL byte, a `-diff` attribute or key material). Content is still passed with --text. */
  readonly binaryPaths: readonly string[];
  /**
   * What `diff` holds: the commit's patch, or its raw commit object (author, committer and message). The scanner is
   * called once for each, per commit, and must treat "message" as plain text rather than a diff.
   */
  readonly part: "patch" | "message";
}

/** PSH-1 hook point: scan one part (patch or message) of one outgoing commit. Findings must never contain the secret itself. */
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
  /**
   * G2: throws when the worktree no longer matches what the user reviewed for `reviewedTreeHash`. Called inside
   * commit's check, after the lock is held and `assertNoDrift` ran, as its last step before git runs. It must
   * REFUSE BY THROWING and resolve with `undefined`: a resolved value (a `{ fresh: false }` result, `false`) is treated as
   * a refusal, so a mistaken wiring cannot fail open. Any throw becomes E_CONFLICT `details.reason: "stale"`, except a
   * GitOpsError with another code, which is passed on unchanged.
   */
  readonly assertReviewFresh?: (worktree: WorktreeRef, reviewedTreeHash: string) => Promise<void>;
  /** Tests and callers with their own filesystem: does this absolute path exist? Default: `lstat` (a missing path is false, any other error throws). */
  readonly fileExists?: (path: string) => boolean | Promise<boolean>;
  readonly scanner?: SecretScanner;
  readonly scanMode?: "warn" | "refuse";
  /** Windows only: an empty directory used as core.hooksPath (POSIX uses /dev/null). */
  readonly emptyHooksDir?: string;
  readonly platform?: NodeJS.Platform;
}
