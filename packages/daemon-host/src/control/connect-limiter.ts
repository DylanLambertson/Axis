// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import type { Clock } from "../ports/clock.js";

/**
 * The per-window connect rate limit (design section 5.2): a token bucket per `windowId`, by default 10 connects a
 * minute with a burst of 5, applied before `daemon.accept`. The map is bounded. An entry is only evicted when its
 * bucket is back to full (forgetting it loses nothing), so a flood of new window ids cannot reset the limit of a
 * window that is being throttled; with no such entry to evict, a new window is refused (fail closed).
 */

export const DEFAULT_CONNECTS_PER_MINUTE = 10;
export const DEFAULT_CONNECT_BURST = 5;
export const DEFAULT_MAX_WINDOWS = 1_024;

export interface ConnectLimiterOptions {
  readonly clock: Clock;
  readonly connectsPerMinute?: number;
  readonly burst?: number;
  readonly maxWindows?: number;
}

export interface ConnectLimiter {
  /** Take one token for `windowId`. False means over the limit: close the port, say nothing. */
  tryAcquire(windowId: string): boolean;
  /** Windows currently tracked. */
  readonly size: () => number;
}

interface Bucket {
  tokens: number;
  at: number;
}

export function createConnectLimiter(options: ConnectLimiterOptions): ConnectLimiter {
  const perMinute = options.connectsPerMinute ?? DEFAULT_CONNECTS_PER_MINUTE;
  const burst = options.burst ?? DEFAULT_CONNECT_BURST;
  const maxWindows = options.maxWindows ?? DEFAULT_MAX_WINDOWS;
  for (const [name, v, max] of [["connectsPerMinute", perMinute, 600], ["burst", burst, 100], ["maxWindows", maxWindows, 65_536]] as const) {
    if (!Number.isInteger(v) || v < 1 || v > max) throw new AxisError("E_INVALID_ARGUMENT", "Invalid connect limit", { reason: name });
  }
  const perMs = perMinute / 60_000;
  const buckets = new Map<string, Bucket>();

  const refill = (b: Bucket, now: number): void => {
    // The monotonic clock never goes backwards; a negative step is treated as none, never as credit.
    const elapsed = Math.max(0, now - b.at);
    b.tokens = Math.min(burst, b.tokens + elapsed * perMs);
    b.at = now;
  };

  return {
    tryAcquire(windowId: string): boolean {
      const now = options.clock.monotonic();
      let bucket = buckets.get(windowId);
      if (bucket === undefined) {
        if (buckets.size >= maxWindows) {
          for (const [id, b] of buckets) {
            refill(b, now);
            if (b.tokens >= burst) buckets.delete(id);
          }
          if (buckets.size >= maxWindows) return false;
        }
        bucket = { tokens: burst, at: now };
        buckets.set(windowId, bucket);
      } else {
        refill(bucket, now);
      }
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
    size: () => buckets.size,
  };
}
