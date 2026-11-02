// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

export { WorktreeError, isWorktreeError, type WorktreeErrorCode } from './errors.js';
export {
  buildGitEnv, createExecGitRunner,
  type ExecGitRunnerOptions, type GitResult, type GitRunOptions, type GitRunner,
} from './git.js';
export { markDiscardConfirmed, isDiscardConfirmed, type DiscardConfirmation } from './confirmation.js';
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
export {
  BACKUP_RETENTION_DAYS, RUNBASE_RETENTION_DAYS, WorktreeManager, type WorktreeManagerOptions,
} from './manager.js';
export {
  parsePorcelainStatus,
  type CreateInput, type CreatedWorkspace, type DirtyFile, type FinaliseOutcome, type FinaliseResult,
  type RemoveResult, type RestoreResult, type WorkspaceStatus, type WorktreeInfo,
} from './types.js';
