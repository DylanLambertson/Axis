// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import { summarizeError } from "./log/summarize-error.js";

/**
 * Process exit codes of the host (design sections 3 and 8). 70, 75 and 78 follow sysexits.h (`EX_SOFTWARE`,
 * `EX_TEMPFAIL`, `EX_CONFIG`) so a supervisor can tell the failure classes apart without parsing output.
 */
export const EXIT = Object.freeze({
  /** Clean shutdown. */
  OK: 0,
  /** Shutdown finished with cancelled or unsettled work. */
  UNSETTLED: 1,
  /** Internal error, an uncaught exception, or the contract coverage check failed. */
  INTERNAL: 70,
  /** The data directory is locked by another daemon. */
  LOCK_HELD: 75,
  /** The configuration or the data directory was refused. */
  BAD_CONFIG: 78,
  /** Started degraded and was asked to stop on that. */
  DEGRADED: 79,
} as const);

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Exit code for an error thrown before the host was ready. Step 3 of the startup order: `E_CONFLICT` is a second
 * daemon (75), `E_INVALID_ARGUMENT` and `E_POLICY_DENIED` are a bad configuration or data directory (78).
 * Everything else, including a value that is not an error, is internal (70).
 */
export function exitCodeForStartupError(error: unknown): ExitCode {
  if (error instanceof DegradedStartError) return EXIT.DEGRADED;
  switch (summarizeError(error).code) {
    case "E_CANCELLED":
      // A stop requested while starting: a clean stop, not an internal error.
      return EXIT.OK;
    case "E_CONFLICT":
      return EXIT.LOCK_HELD;
    case "E_INVALID_ARGUMENT":
    case "E_POLICY_DENIED":
      return EXIT.BAD_CONFIG;
    default:
      return EXIT.INTERNAL;
  }
}

/**
 * Thrown by `start()` when the host came up degraded and the supervisor asked it not to run that way
 * (`exitOnDegraded`). Exit code 79. `reason` is the closed reason code that `ready.degraded` would have carried.
 */
export class DegradedStartError extends AxisError {
  constructor(readonly reason: string) {
    super("E_UNAVAILABLE", "The host started degraded", { reason });
  }
}
