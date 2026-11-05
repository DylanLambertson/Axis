// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import { DaemonError } from "@axis/daemon";

/**
 * Closed error mapping for the worktrees binding (design section 9). Every message below is a constant: nothing
 * the manager, git, the journal or a caught error said is ever forwarded, because those texts carry absolute paths,
 * ref names and git's own output. Only the code and one `reason` from a closed set reach the wire.
 */

/** The reasons a refusal can state, by the name `@axis/worktrees` gives them (hyphenated) and the wire name. */
const REASONS: Readonly<Record<string, string>> = {
  "active-run": "active_run",
  dirty: "dirty",
  "unbacked-data": "unbacked_data",
  "confirmation-stale": "confirmation_stale",
  "confirmation-spent": "confirmation_spent",
  "confirmation-expired": "confirmation_expired",
  "git-drift": "git_drift",
  "not-finalised": "not_finalised",
  "no-archive": "no_archive",
  "no-base-branch": "no_base_branch",
  "not-merged": "not_merged",
  "branch-mismatch": "branch_mismatch",
  "runbase-moved": "runbase_moved",
  "git-path": "git_path",
};

const REASON_TEXT: Readonly<Record<string, string>> = {
  active_run: "A run is active in this workspace.",
  dirty: "The workspace has uncommitted changes; confirm to discard them.",
  unbacked_data: "The workspace holds files a backup cannot keep; confirm to discard them.",
  confirmation_stale: "The files changed after you confirmed; confirm again.",
  confirmation_spent: "That confirmation was already used.",
  confirmation_expired: "That confirmation expired; confirm again.",
  git_drift: "The git configuration changed; review it first.",
  not_finalised: "The workspace must be finalised before it is removed.",
  no_archive: "The workspace has no archive ref.",
  no_base_branch: "The base branch is not available.",
  not_merged: "The workspace is not merged into its base branch.",
  branch_mismatch: "The branch does not belong to this workspace.",
  runbase_moved: "The run base moved since the run started.",
  git_path: "The git executable is not usable.",
};

const CODE_TEXT = {
  E_INVALID_ARGUMENT: "The request is not valid for this workspace.",
  E_NOT_FOUND: "The workspace or item was not found.",
  E_CONFLICT: "The workspace is not in a state that allows this.",
  E_UNAVAILABLE: "This workspace needs attention and is unavailable.",
  E_INTERNAL: "The worktree operation failed.",
} as const;

export type WorktreeFailureCode = keyof typeof CODE_TEXT;

/** Reasons the host itself states (not from the manager). */
const EXTRA_TEXT: Readonly<Record<string, string>> = {
  already_finalised: "The workspace is already finalised.",
  not_ready: "The workspace is not ready for this.",
  base_moved: "The base moved while the workspace was created.",
  base_ref: "The base ref does not exist.",
  busy: "The workspace is busy.",
  needs_attention: "This workspace needs attention and is unavailable.",
  path_changed: "The workspace location changed.",
  unverified: "The earlier finalise could not be verified; it needs attention.",
  unsafe_path: "A path in the request is not a plain file path inside the workspace.",
  partial_restore: "Some files were restored before the request failed.",
};

const reasonText = (reason: string): string | undefined =>
  Object.hasOwn(REASON_TEXT, reason) ? REASON_TEXT[reason] : Object.hasOwn(EXTRA_TEXT, reason) ? EXTRA_TEXT[reason] : undefined;

/** A `DaemonError` with a fixed text for the code and, when `reason` is in the closed set, that reason and its text. */
export function worktreeFailure(code: WorktreeFailureCode, reason?: string): DaemonError {
  const text = reason === undefined ? undefined : reasonText(reason);
  return text === undefined ? new DaemonError(code, CODE_TEXT[code]) : new DaemonError(code, text, { reason: reason as string });
}

/** What `@axis/worktrees` threw (its closed code and `details.reason`), as the error the daemon answers. */
export function fromWorktreeError(code: string, reason: unknown): DaemonError {
  const mapped = typeof reason === "string" && Object.hasOwn(REASONS, reason) ? REASONS[reason] : undefined;
  switch (code) {
    case "E_INVALID_ARGUMENT":
      return worktreeFailure("E_INVALID_ARGUMENT");
    case "E_NOT_FOUND":
      return worktreeFailure("E_NOT_FOUND");
    case "E_CONFLICT":
      return worktreeFailure("E_CONFLICT", mapped);
    // A package refusal (location, git drift, ...) is a conflict the user can act on: only the daemon may say E_POLICY_DENIED.
    case "E_POLICY_DENIED":
      return worktreeFailure("E_CONFLICT", mapped);
    default:
      return worktreeFailure("E_INTERNAL");
  }
}

/** Anything a handler may catch, as the one error the daemon turns into a wire answer. A `DaemonError` passes unchanged. */
export function toDaemonError(error: unknown): DaemonError {
  if (error instanceof DaemonError) return error;
  if (error instanceof AxisError) {
    switch (error.code) {
      case "E_NOT_FOUND":
      case "E_CONFLICT":
      case "E_INVALID_ARGUMENT":
      case "E_BACKPRESSURE":
      case "E_UNAVAILABLE":
        return error.code === "E_BACKPRESSURE" ? new DaemonError("E_BACKPRESSURE", "Too many requests are waiting.") : worktreeFailure(error.code);
      default:
        break;
    }
  }
  return worktreeFailure("E_INTERNAL");
}
