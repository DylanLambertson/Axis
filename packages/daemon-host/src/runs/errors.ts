// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import { DaemonError } from "@axis/daemon";

/**
 * Closed error mapping for `axis.cli-runs/1` (design section 9). Every message is a constant: nothing the supervisor, the
 * journal, the pty or a caught error said is forwarded, because those texts can carry paths, executable names and
 * environment facts. Only the code and one `reason` from a closed set reach the wire. A handler cannot raise
 * `E_POLICY_DENIED` (only the daemon decides it), so a refusal the supervisor words that way (`UNTRUSTED`, a stale or
 * spent attestation) is answered `E_CONFLICT` with its reason.
 */
const REASON_TEXT: Readonly<Record<string, string>> = {
  untrusted: "The workspace is not trusted.",
  not_ready: "The workspace is not ready for a run.",
  busy: "The workspace is busy.",
  active_run: "A run or one of its processes is still active in this workspace.",
  needs_attention: "This workspace needs attention and is unavailable.",
  git_operation_active: "A commit or push is in progress in this workspace.",
  run_limit: "Too many runs are active.",
  attestation_expired: "The trust check is too old; start the run again.",
  attestation_used: "The trust check was already used.",
  attestation_mismatch: "The trust check does not belong to this workspace.",
  executable_changed: "The CLI executable changed while the run was starting.",
  agent_unknown: "That CLI is not configured.",
  agent_invalid: "The CLI definition is not acceptable.",
  settings_unavailable: "The CLI settings could not be read.",
  worktree_unavailable: "The workspace could not be located.",
  executable_not_found: "The CLI executable was not found.",
  bad_worktree: "The workspace location is not acceptable.",
  invalid_env: "The CLI environment is not usable.",
  outcome_unknown: "The outcome of the start is not known; check the run list.",
};

/** The supervisor's `details.reason` codes, by the wire name each one gets. */
const FROM_SUPERVISOR: Readonly<Record<string, string>> = {
  UNTRUSTED: "untrusted",
  NOT_ATTESTED: "untrusted",
  ATTESTATION_USED: "attestation_used",
  ATTESTATION_MISMATCH: "attestation_mismatch",
  ATTESTATION_EXPIRED: "attestation_expired",
  INVALID_AGENT: "agent_invalid",
  WORKTREE_UNAVAILABLE: "worktree_unavailable",
  WORKSPACE_NOT_FOUND: "worktree_unavailable",
  WORKSPACE_NOT_READY: "not_ready",
  GIT_OPERATION_ACTIVE: "git_operation_active",
  RUN_LIMIT: "run_limit",
  BAD_WORKTREE: "bad_worktree",
  INVALID_ENV: "invalid_env",
  EXECUTABLE_NOT_FOUND: "executable_not_found",
  EXECUTABLE_CHANGED: "executable_changed",
};

const CODE_TEXT = {
  E_INVALID_ARGUMENT: "The request is not valid.",
  E_NOT_FOUND: "The workspace or run was not found.",
  E_CONFLICT: "The workspace is not in a state that allows this.",
  E_UNAVAILABLE: "The run could not be started right now.",
  E_BACKPRESSURE: "Too many requests are waiting.",
  E_TIMEOUT: "The CLI did not start in time.",
  E_CANCELLED: "The request was cancelled.",
  E_INTERNAL: "The run operation failed.",
} as const;

export type RunFailureCode = keyof typeof CODE_TEXT;

/** A `DaemonError` with a fixed text for the code and, when `reason` is in the closed set, that reason and its text. */
export function runFailure(code: RunFailureCode, reason?: string): DaemonError {
  const text = reason === undefined || !Object.hasOwn(REASON_TEXT, reason) ? undefined : REASON_TEXT[reason];
  return text === undefined ? new DaemonError(code, CODE_TEXT[code]) : new DaemonError(code, text, { reason: reason as string });
}

/** Anything the supervisor or a guard may throw, as the one error the daemon turns into a wire answer. */
export function toRunError(error: unknown): DaemonError {
  if (error instanceof DaemonError) return error;
  if (error instanceof AxisError) {
    const raw = error.detail["reason"];
    const reason = typeof raw === "string" && Object.hasOwn(FROM_SUPERVISOR, raw) ? FROM_SUPERVISOR[raw] : undefined;
    switch (error.code) {
      case "E_POLICY_DENIED":
        return runFailure("E_CONFLICT", reason ?? "untrusted");
      case "E_NOT_FOUND":
      case "E_CONFLICT":
      case "E_INVALID_ARGUMENT":
        return runFailure(error.code, reason);
      case "E_BACKPRESSURE":
        // The reason shows in the fixed text only: the wire allows no `reason` detail on this code.
        return new DaemonError("E_BACKPRESSURE", reason === "run_limit" ? REASON_TEXT["run_limit"] as string : CODE_TEXT.E_BACKPRESSURE);
      case "E_UNAVAILABLE":
      case "E_TIMEOUT":
      case "E_CANCELLED":
        return runFailure(error.code);
      default:
        break;
    }
  }
  return runFailure("E_INTERNAL");
}
