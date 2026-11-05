// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/** Time, injected so tests control it and the host never reads the system clock directly. */
export interface Clock {
  /** Wall-clock time in milliseconds since the epoch. For timestamps and attestation freshness. */
  now(): number;
  /** Monotonic milliseconds. For durations, budgets and expiry; never goes backwards. */
  monotonic(): number;
}
