// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

export { WorktreeError, isWorktreeError, toWorktreeError, type WorktreeErrorCode } from './errors.js';
export {
  buildGitEnv, createExecGitRunner, resolveGitPath,
  type ExecGitRunnerOptions, type GitResult, type GitRunOptions, type GitRunner,
} from './git.js';
export type { DiscardBinding, DiscardConfirmation, DiscardOp } from './confirmation.js';
export {
  parseWorktreeList, projectDirName, repoHash, resolveRepo,
  type RepoLocation, type WorktreeEntry,
} from './discovery.js';
export {
  assertNoTraversal, canonicalise, defaultWorktreeRoot, isSameOrInside, validateWorktreeRoot,
  type ProtectedLocation,
} from './paths.js';
export {
  diffGitSnapshots, type DriftItem, type GitSnapConfigEntry, type GitSnapFile, type GitSnapshot,
} from './gitSnap.js';
export { SLUG_PATTERN, WorkspaceMetaSchema, type WorkspaceMeta } from './meta.js';
export { MAX_SNAPSHOT_FILE_BYTES, type SnapshotResult } from './snapshotRef.js';
export type { SnapshotFinding, SnapshotScanner } from './snapshotScan.js';
export {
  BACKUP_RETENTION_DAYS, RUNBASE_RETENTION_DAYS, WorktreeManager, type ActiveRunOp, type WorktreeManagerOptions,
} from './manager.js';
export {
  parsePorcelainStatus,
  type CreateInput, type CreatedWorkspace, type DirtyFile, type ExpectedWorktree, type FinaliseOutcome, type FinaliseResult,
  type RemoveResult, type RestoreResult, type WorkspaceStatus, type WorktreeInfo,
} from './types.js';
export type { DiscardScan } from './discard.js';
export { acquireFileLock } from './lock.js';
export { createHooksGuard, redact, type HooksGuard } from './hardenedGit.js';
export { MERGED_CHECK_ENV, verifyMerged, type MergedProbe, type MergedVerdict } from './mergedCheck.js';
