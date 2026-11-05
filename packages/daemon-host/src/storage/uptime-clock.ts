// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Clock } from "../ports/clock.js";

/**
 * The monotonic source the idempotency store runs on (design section 5.1, the clock re-review of step 8).
 *
 * The store counts uptime: `trusted = saved + (reading - reading at open)`, and expires a key when that counter passes
 * the key's expiry. What can hurt is a reading that jumps FORWARD (a key then expires early, so a retry would run a
 * write twice) or that is not a finite non-negative number (the store refuses it with `E_INTERNAL` in the middle of a
 * request). A reading that goes backwards is harmless to the store (its counter never decreases) but is hidden here too.
 * So this wrapper:
 *  - never returns less than it returned before, and never a value that is not finite and non-negative;
 *  - never advances by more than `maxStepMs` between two reads (a suspended machine, a stepped clock or a bad source
 *    can make a key expire early by at most `maxStepMs` per jump; the excess is dropped, so everything beyond that
 *    makes keys live LONGER, the safe direction).
 * The host also reads it on a timer well inside `maxStepMs`, so honest idle time is counted in full.
 */
export const DEFAULT_MAX_UPTIME_STEP_MS = 10 * 60_000;

export interface UptimeClock {
  /** Accumulated, bounded monotonic milliseconds. Pass this as the store's `monotonic`. */
  read(): number;
  /** Source steps that were clamped (a jump) or hidden (backwards or invalid), for tests and diagnostics. */
  readonly anomalies: () => number;
}

export function createUptimeClock(clock: Clock, maxStepMs: number = DEFAULT_MAX_UPTIME_STEP_MS): UptimeClock {
  if (!Number.isInteger(maxStepMs) || maxStepMs < 1_000 || maxStepMs > 3_600_000) throw new RangeError("Invalid maxStepMs");
  const sample = (): number | undefined => {
    try {
      const v = clock.monotonic();
      return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
    } catch {
      return undefined;
    }
  };
  let last = sample();
  let total = 0;
  let anomalies = 0;
  return {
    read(): number {
      const now = sample();
      if (now === undefined || last === undefined) {
        anomalies++;
        if (now !== undefined) last = now;
        return total;
      }
      const step = now - last;
      if (step < 0) anomalies++;
      else if (step > maxStepMs) {
        anomalies++;
        total += maxStepMs;
      } else total += step;
      last = Math.max(last, now);
      return total;
    },
    anomalies: () => anomalies,
  };
}
