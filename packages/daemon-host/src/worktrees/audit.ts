// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DEFAULT_PAYLOAD_ALLOWLIST } from "@axis/audit";

/**
 * Audit payload keys of the worktree events the binding writes in the same transaction as the journal change. Every
 * value is a flag, a count, a closed word or an id the host made: never a path, a file name or file content. (The
 * three lists of data a backup does not hold are counts, because the files' names are the user's and the dialog
 * already showed them.) Merged over the audit package's own entries by `createChallengeAuditLog`.
 */
export const WORKTREE_PAYLOAD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "worktree.finalise": Object.freeze(["workspaceId", "outcome", "phase", "backupRef", "skippedLarge"]),
  "worktree.remove": Object.freeze([
    ...(DEFAULT_PAYLOAD_ALLOWLIST["worktree.remove"] ?? []),
    "branchBackupRef",
    "skippedLarge",
    "ignored",
    "skippedUnsupported",
  ]),
  "worktree.restore": Object.freeze(["workspaceId", "runId", "fileCount", "backupRef"]),
});
