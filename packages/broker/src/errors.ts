// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { ErrorCode } from "@axis/protocol";

/** Why a request was refused. A closed set, so tests and audit payloads can match on it. */
export type Reason =
  | "invalid-path" | "dotdot" | "backslash" | "drive-prefix" | "unc-or-device" | "win-name" | "outside-root"
  | "unregistered" | "root-moved" | "root-in-repository" | "symlink-escape" | "symlink-dangling" | "swapped"
  | "not-regular" | "hardlink" | "exists" | "not-found" | "too-large" | "fs-error" | "stale" | "not-text"
  | "unknown-tool" | "invalid-tier" | "invalid-args" | "invalid-call" | "protected-path" | "no-approval-hook"
  | "approval-declined" | "approval-malformed" | "approval-expired" | "approval-mismatch" | "approval-replayed"
  | "approval-timeout" | "approval-error" | "bad-approver" | "audit-failed"
  | "invalid-command" | "invalid-env" | "unresolved-command" | "too-many-processes"
  | "undeclared-path" | "undeclared-command" | "undeclared-git" | "program-changed" | "path-changed" | "approval-limit" | "git-command" | "git-flag" | "git-rev" | "git-path" | "git-drift" | "git-unavailable" | "aborted";

type Scalar = string | number | boolean;

/**
 * A refusal or failure with a code from the closed `@axis/protocol` set. The message is fixed text and the details
 * hold scalars only: never a path, a command line, an environment value or a `cause`, so an error cannot carry a
 * secret out of the package.
 */
export class BrokerError extends Error {
  readonly code: ErrorCode;
  readonly reason: Reason;
  readonly details: Readonly<Record<string, Scalar>>;
  constructor(code: ErrorCode, reason: Reason, message: string, details: Readonly<Record<string, Scalar>> = {}) {
    super(message);
    this.name = "BrokerError";
    this.code = code;
    this.reason = reason;
    this.details = Object.freeze({ reason, ...details });
  }
}

export const denied = (reason: Reason, message: string, details?: Readonly<Record<string, Scalar>>): BrokerError =>
  new BrokerError("E_POLICY_DENIED", reason, message, details);
export const invalid = (reason: Reason, message: string, details?: Readonly<Record<string, Scalar>>): BrokerError =>
  new BrokerError("E_INVALID_ARGUMENT", reason, message, details);

/** Any thrown value as a BrokerError. Unknown errors lose their text: it may carry paths or content. */
export function toBrokerError(e: unknown): BrokerError {
  if (e instanceof BrokerError) return e;
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  const errno = typeof code === "string" && /^E[A-Z0-9]{1,15}$/.test(code) ? code : undefined;
  return new BrokerError("E_INTERNAL", "fs-error", "the tool failed", errno === undefined ? {} : { errno });
}
