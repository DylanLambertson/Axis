// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { makeError, type AxisError as WireError, type ErrorCode } from "@axis/protocol";

/**
 * Structured error over the protocol's closed code set. `message` is user-safe:
 * it never contains a challenge id, digest, proof or target. When
 * `@axis/audit` lands in the workspace the daemon can unify this with its
 * `AxisError`; the codes already come from the same place.
 */
export class ChallengeError extends Error {
  readonly code: ErrorCode;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: ErrorCode,
    message: string,
    detail: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(message);
    this.name = "ChallengeError";
    this.code = code;
    this.detail = detail;
  }

  toWire(correlationId: string): WireError {
    return Object.keys(this.detail).length === 0
      ? makeError(this.code, this.message, correlationId)
      : makeError(this.code, this.message, correlationId, { ...this.detail });
  }
}
