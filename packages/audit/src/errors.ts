// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

import { ERROR_CODES, makeError, type AxisError as WireError, type ErrorCode } from "@axis/protocol";

// One source of truth: the closed set lives in @axis/protocol (ADR 0003 D3).
export { ERROR_CODES, type ErrorCode };

/**
 * A structured error. `message` must be user-safe: callers never put secrets,
 * payloads or stack traces in it. `detail` carries small machine-readable
 * facts (for example the first bad sequence number).
 */
export class AxisError extends Error {
  readonly code: ErrorCode;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: ErrorCode,
    message: string,
    detail: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(message);
    this.name = "AxisError";
    this.code = code;
    this.detail = detail;
  }

  /** The wire shape (`@axis/protocol` `AxisError`) for the bridge. */
  toWire(correlationId: string): WireError {
    return Object.keys(this.detail).length === 0
      ? makeError(this.code, this.message, correlationId)
      : makeError(this.code, this.message, correlationId, { ...this.detail });
  }
}
