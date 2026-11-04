// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { GitOpsDeps, WorktreeRef } from "@axis/git-ops";

/** A temporary git index file, owned by the daemon. The package never touches the file system itself. */
export interface TempIndex {
  /** Absolute path of a file that does not exist yet or may be overwritten. */
  readonly path: string;
  /** Called in a `finally`, after the last git process using the index has ended. */
  dispose(): Promise<void>;
}

export interface TempIndexProvider {
  create(): Promise<TempIndex>;
}

export interface ProtectedHit {
  /** A short rule name such as "ci-workflow". Bounded and escaped before it reaches a view. */
  readonly rule: string;
}

/** WT-3 highlighting. The @axis/git-snapshot matcher satisfies this structurally. Called with repository-relative paths. */
export interface ProtectedPathMatcher {
  match(path: string): readonly ProtectedHit[];
}

export interface ReviewLimits {
  readonly maxFiles: number;
  readonly maxPreviewBytes: number;
  readonly maxHunkFileBytes: number;
  readonly maxPatchBytes: number;
  readonly maxHunksPerFile: number;
  readonly maxDisplay: number;
  readonly maxLedger: number;
  readonly maxSymlinkReads: number;
  readonly maxCachedPatchBytes: number;
  readonly maxStalePaths: number;
  /** A worktree file larger than this is left out of the snapshot and listed as skipped (not silently). */
  readonly maxSnapshotFileBytes: number;
}

export interface ReviewDeps {
  /** The object the daemon already passes to @axis/git-ops: runner, GIT-ENV-1 environment, platform. Only daemon-context git is used. */
  readonly git: GitOpsDeps;
  readonly tempIndex: TempIndexProvider;
  /** Whether an absolute path exists. Used for the git directory's in-progress markers; the package has no file system of its own. */
  readonly fileExists: (absolutePath: string) => Promise<boolean>;
  readonly protectedPaths?: ProtectedPathMatcher;
  readonly limits?: Partial<ReviewLimits>;
}

export type ChangeStatus = "A" | "M" | "D" | "R" | "T";
export type ChangeKind = "text" | "binary" | "symlink" | "submodule" | "too-large" | "filtered";

export interface ReviewFile {
  /** Repository-relative, as git has it. Use for operations; never show it. */
  readonly path: string;
  /** Set for a rename. */
  readonly oldPath?: string;
  readonly status: ChangeStatus;
  readonly kind: ChangeKind;
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldOid: string;
  readonly newOid: string;
  readonly similarity?: number;
  readonly additions?: number;
  readonly deletions?: number;
  readonly displayPath: string;
  readonly displayOldPath?: string;
  /** The path (or a rename side) is not usable: it cannot be accepted. Why is in `warnings`. */
  readonly unsafePath: boolean;
  /** WT-3: rule names that matched the path (or either side of a rename). */
  readonly protectedRules: readonly string[];
  /** Why only a whole-file decision is offered, when hunks are not. */
  readonly fileLevelReason?: string;
  readonly link?: { readonly target: string | undefined; readonly escapesWorktree: boolean };
  /** Short machine-readable labels for the UI: "unsafe-path:<why>", "symlink-outside", "submodule", "binary", and so on. */
  readonly warnings: readonly string[];
}

export interface ChangeList {
  readonly files: readonly ReviewFile[];
}

export interface ReviewInput {
  readonly worktree: WorktreeRef;
  /** Full object id of a commit. For a review that will be committed it must be HEAD (design §3). */
  readonly against: string;
}

/** A worktree file left out of the snapshot because it is larger than `maxSnapshotFileBytes`. It cannot be reviewed or accepted. */
export interface SkippedFile {
  readonly path: string;
  readonly displayPath: string;
  readonly size: number;
  readonly reason: "too_large_to_review";
}
