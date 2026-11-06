// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import { DaemonError } from "@axis/daemon";

/**
 * Closed error mapping for `axis.runs/1` (the shape of `runs/errors.ts`). Every message is a constant and only one
 * `reason` from a closed set reaches the wire: nothing a provider, the broker, the journal or a caught error said is
 * forwarded. A handler cannot raise `E_POLICY_DENIED` (only the daemon decides it).
 */
const REASON_TEXT: Readonly<Record<string, string>> = {
  not_ready: "The workspace is not ready for a run.",
  needs_attention: "This workspace needs attention and is unavailable.",
  active_run: "A composer run is already active in this workspace.",
  provider_unknown: "That provider is not available.",
  model_unknown: "That model is not offered by the provider.",
  provider_unavailable: "The provider could not be reached.",
  worktree_unavailable: "The workspace could not be located.",
  not_cancellable: "The run is not in a state that can be cancelled.",
  shutting_down: "The agent service is stopping.",
};

const CODE_TEXT = {
  E_INVALID_ARGUMENT: "The request is not valid.",
  E_NOT_FOUND: "The workspace or run was not found.",
  E_CONFLICT: "The workspace or run is not in a state that allows this.",
  E_UNAVAILABLE: "The agent service is unavailable right now.",
  E_BACKPRESSURE: "Too many composer runs are active.",
  E_CANCELLED: "The request was cancelled.",
  E_INTERNAL: "The composer operation failed.",
} as const;

export type ComposerFailureCode = keyof typeof CODE_TEXT;

/** A `DaemonError` with a fixed text for the code and, when `reason` is in the closed set, that reason and its text. */
export function composerFailure(code: ComposerFailureCode, reason?: string): DaemonError {
  const text = reason === undefined || !Object.hasOwn(REASON_TEXT, reason) ? undefined : REASON_TEXT[reason];
  return text === undefined ? new DaemonError(code, CODE_TEXT[code]) : new DaemonError(code, text, { reason: reason as string });
}

/** Anything the service or the journal may throw, as the one error the daemon turns into a wire answer. */
export function toComposerError(error: unknown): DaemonError {
  if (error instanceof DaemonError) return error;
  if (error instanceof AxisError) {
    switch (error.code) {
      case "E_NOT_FOUND":
        return composerFailure("E_NOT_FOUND");
      case "E_CONFLICT":
      case "E_POLICY_DENIED":
        return composerFailure("E_CONFLICT");
      case "E_INVALID_ARGUMENT":
        return composerFailure("E_INVALID_ARGUMENT");
      case "E_CANCELLED":
        return composerFailure("E_CANCELLED");
      default:
        break;
    }
  }
  return composerFailure("E_INTERNAL");
}
