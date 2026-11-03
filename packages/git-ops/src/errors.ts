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

export function denied(message: string): GitOpsError {
  return new GitOpsError("E_POLICY_DENIED", message);
}
export function invalid(message: string): GitOpsError {
  return new GitOpsError("E_INVALID_ARGUMENT", message);
}
export function conflict(message: string): GitOpsError {
  return new GitOpsError("E_CONFLICT", message);
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
