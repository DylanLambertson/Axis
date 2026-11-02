// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * Structured error codes. The names follow the daemon's contract vocabulary
 * (a subset of the closed `@axis/protocol` error set: E_INVALID_ARGUMENT, E_POLICY_DENIED, E_NOT_FOUND, E_CONFLICT, E_INTERNAL) so the transport layer can map them 1:1.
 */
export type WorktreeErrorCode =
  | 'E_INVALID_ARGUMENT' // malformed input (slug, ref, option)
  | 'E_NOT_FOUND' // repository, worktree, ref or path does not exist / is not managed
  | 'E_CONFLICT' // state precondition failed (branch exists, dirty, not finalised)
  | 'E_POLICY_DENIED' // a safety rule refused the request (location policy, symlink escape)
  | 'E_INTERNAL'; // the git CLI failed or could not be started (details.stderr)

export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: WorktreeErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'WorktreeError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function isWorktreeError(value: unknown): value is WorktreeError {
  return value instanceof WorktreeError;
}
