// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * The part of `WorktreeManager` (`@axis/worktrees`) the host's worktrees service uses, as structural types. Only
 * `src/bindings/worktrees.ts` may import that package, so everything else is written against these shapes, and the
 * binding is where the compiler proves the real manager still fits them. Every method takes a path the host's
 * locator produced (never a caller's) and rejects with a `DaemonError` (the binding maps the package's errors).
 */
export interface DirtyEntry {
  readonly index: string;
  readonly worktree: string;
}

export interface ListedWorktree {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly locked: boolean;
  readonly prunable: boolean;
  readonly isMain: boolean;
  readonly managed: boolean;
  readonly external: boolean;
  readonly id: string | null;
}

export interface ManagerStatus {
  readonly id: string;
  readonly branch: string | null;
  readonly head: string;
  readonly baseSha: string;
  readonly state: "READY" | "FINALISED";
  readonly dirty: readonly DirtyEntry[];
  readonly ahead: number;
  readonly behind: number;
}

export interface ManagerCreated {
  readonly id: string;
  readonly branch: string;
  readonly path: string;
  readonly baseSha: string;
  /** The full `refs/heads/...` name the base resolved to, or null when it was not a local branch. */
  readonly baseBranch: string | null;
}

export interface ManagerDiscardScan {
  readonly fingerprint: string;
  readonly dirty: readonly unknown[];
  readonly skippedLarge: readonly string[];
  readonly ignored: readonly string[];
  readonly skippedUnsupported: readonly string[];
}

export interface ManagerFinalised {
  readonly archiveRef: string;
  readonly backupRef: string | null;
  readonly skippedLarge: readonly string[];
}

export interface ManagerRemoved {
  readonly backupRef: string | null;
  readonly branchDeleted: boolean;
  readonly branchBackupRef: string | null;
  readonly skippedLarge: readonly string[];
  readonly ignored: readonly string[];
  readonly skippedUnsupported: readonly string[];
}

export interface ManagerRestored {
  readonly relPath: string;
  readonly backupRef: string;
}

/** The workspace the host resolved (its canonical root and its id): the manager refuses any path that no longer leads to exactly it. */
export interface ExpectedWorktree {
  readonly path: string;
  readonly id: string;
}

export interface ManagerShape {
  /** The commit a ref names in the project's repository (read only). Rejects `E_NOT_FOUND` when it names none. */
  resolveCommit(repoPath: string, ref: string): Promise<string>;
  /** Full names of the refs under `prefix` (for example `refs/axis/archive/`) in the project's repository (read only). */
  listRefs(repoPath: string, prefix: string): Promise<ReadonlySet<string>>;
  /**
   * True when `headSha` is reachable from `baseBranch` (a full `refs/heads/...` name the journal recorded), by git itself, and
   * the branch still descends from `baseTip`, the commit the journal recorded it at (FU-WT-BASE2). Never reads `HEAD`.
   */
  isMerged(repoPath: string, headSha: string, baseBranch: string, baseTip: string): Promise<boolean>;
  list(repoPath: string): Promise<readonly ListedWorktree[]>;
  create(input: { repoPath: string; slug: string; baseRef: string; id: string }): Promise<ManagerCreated>;
  status(worktreePath: string, expected: ExpectedWorktree): Promise<ManagerStatus>;
  previewDiscard(worktreePath: string, expected: ExpectedWorktree): Promise<ManagerDiscardScan>;
  assertNoDrift(worktreePath: string, expected: ExpectedWorktree): Promise<void>;
  finalise(input: { path: string; expectedWorktree: ExpectedWorktree; outcome: "merged" | "archived" | "abandoned"; discardConfirmation?: unknown; trustedBaseBranch: string | null; trustedBaseTip: string | null }): Promise<ManagerFinalised>;
  remove(input: { path: string; expectedWorktree: ExpectedWorktree; deleteBranch: boolean; discardConfirmation?: unknown }): Promise<ManagerRemoved>;
  restoreFromRunBase(input: { path: string; runId: string; expectedWorktree: ExpectedWorktree }): Promise<ManagerRestored>;
}

/** What the locator needs to know about a repository location (`resolveRepo` of the package). */
export interface RepoFacts {
  readonly gitDir: string;
  readonly workTree: string | null;
  readonly linked: boolean;
}
