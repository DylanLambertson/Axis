// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { ErrorCode } from "@axis/protocol";

/** A refusal with a protocol error code. Messages are fixed text: never a path, a value or a file's content. */
export class SnapshotError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
  }
}

export const invalid = (message: string): SnapshotError => new SnapshotError("E_INVALID_ARGUMENT", message);
export const denied = (message: string): SnapshotError => new SnapshotError("E_POLICY_DENIED", message);

/** Only the errno name of a file system error leaves the package; its message carries the path. */
export function errnoName(e: unknown): string {
  try {
    const code = (e as { code?: unknown } | null)?.code;
    return typeof code === "string" && /^[A-Z0-9_]{2,24}$/.test(code) ? code : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}
