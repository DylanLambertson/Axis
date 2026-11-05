// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { ErrorCode } from "@axis/protocol";

/** A refusal with a protocol error code. Messages never contain credentials. */
export class GitOpsError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, string | number | boolean>> | undefined;
  constructor(code: ErrorCode, message: string, details?: Readonly<Record<string, string | number | boolean>>) {
    super(message);
    this.name = "GitOpsError";
    this.code = code;
    this.details = details;
  }
}

/**
 * What an injected scanner throws when it could not cover all of the text (too large, out of time or work) and is not a bug: the
 * outgoing scan is then incomplete, which `refuse` mode blocks as `scan_incomplete`. Any other throw from a scanner is a failure
 * (`E_UNAVAILABLE`). It carries no text.
 */
export class ScanIncomplete extends Error {
  constructor() {
    super("the secret scan could not cover all of the outgoing changes");
    this.name = "ScanIncomplete";
  }
}

export function denied(message: string, reason?: string): GitOpsError {
  return new GitOpsError("E_POLICY_DENIED", message, reason === undefined ? undefined : { reason });
}
export function invalid(message: string): GitOpsError {
  return new GitOpsError("E_INVALID_ARGUMENT", message);
}
export function conflict(message: string): GitOpsError {
  return new GitOpsError("E_CONFLICT", message);
}

/** HEAD, the branch or the parent is no longer what was reviewed (E_CONFLICT, `details.reason: "head_moved"`). */
export function headMoved(message: string): GitOpsError {
  return new GitOpsError("E_CONFLICT", message, { reason: "head_moved" });
}

export function internal(message: string, details?: Readonly<Record<string, string | number | boolean>>): GitOpsError {
  return new GitOpsError("E_INTERNAL", message, details);
}

/**
 * Runs an operation so that only protocol error codes leave the package. Anything else (a spawn failure, a throwing
 * hook such as the drift check or the scanner) becomes E_UNAVAILABLE with a fixed message: the original text may
 * carry paths or content, so only a short error code such as ENOENT is kept.
 */
export async function mapUnexpected<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof GitOpsError) throw e;
    const code = (e as { code?: unknown } | null)?.code;
    throw new GitOpsError("E_UNAVAILABLE", `git could not be run${typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? ` (${code})` : ""}`);
  }
}

/** Replaces scheme://user:pass@ in text that may reach logs or error details. */
export function redactUrls(text: string): string {
  return text.replace(/(\w+:\/\/)[^/@\s]+@/g, "$1***@");
}

/** Strips terminal escape sequences and control characters (C0, DEL, C1) so untrusted text is safe to show. */
export function sanitizeText(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
