// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { invalid } from "./errors.js";
import type { ReviewLimits } from "./types.js";

export const DEFAULT_LIMITS: ReviewLimits = Object.freeze({
  maxFiles: 5000,
  maxPreviewBytes: 1024 * 1024,
  maxHunkFileBytes: 1024 * 1024,
  maxPatchBytes: 2 * 1024 * 1024,
  maxHunksPerFile: 1000,
  maxDisplay: 512,
  maxLedger: 100_000,
  maxSymlinkReads: 256,
  maxCachedPatchBytes: 32 * 1024 * 1024,
  maxStalePaths: 100,
});

/** Hard ceilings: a caller may lower a limit but cannot raise it past what the package was written to survive. */
const CEILING: ReviewLimits = Object.freeze({
  maxFiles: 20_000,
  maxPreviewBytes: 8 * 1024 * 1024,
  maxHunkFileBytes: 8 * 1024 * 1024,
  maxPatchBytes: 16 * 1024 * 1024,
  maxHunksPerFile: 10_000,
  maxDisplay: 4096,
  maxLedger: 1_000_000,
  maxSymlinkReads: 1024,
  maxCachedPatchBytes: 128 * 1024 * 1024,
  maxStalePaths: 1000,
});

export function resolveLimits(over: Partial<ReviewLimits> | undefined): ReviewLimits {
  const out: Record<string, number> = { ...DEFAULT_LIMITS };
  for (const [k, v] of Object.entries(over ?? {})) {
    if (!Object.hasOwn(CEILING, k)) throw invalid(`unknown review limit ${k.slice(0, 40)}`);
    const max = (CEILING as unknown as Record<string, number>)[k] as number;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) throw invalid(`review limit ${k} must be an integer from 1 to ${max}`);
    out[k] = v;
  }
  return Object.freeze(out) as unknown as ReviewLimits;
}
