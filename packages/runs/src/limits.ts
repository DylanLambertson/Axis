// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import { z } from "zod";
import { MAX_RING_CHARS } from "./ring.js";

export interface RunLimits {
  /** Runs that can still own a process, per device (all workspaces). */
  readonly maxConcurrent: number;
  readonly outputBufferChars: number;
  /** No output for this long marks a live run "quiet (may be waiting for input)". */
  readonly quietMs: number;
  readonly startTimeoutMs: number;
  /** Wait between SIGINT, SIGTERM and SIGKILL. */
  readonly graceMs: number;
  /** After SIGKILL, how long to wait for an exit event before recording the kill as unconfirmed. */
  readonly killTimeoutMs: number;
  readonly snapshotTimeoutMs: number;
  /** How old a trust attestation may be at run start. */
  readonly attestationTtlMs: number;
  readonly cols: number;
  readonly rows: number;
}

export const DEFAULT_LIMITS: RunLimits = Object.freeze({
  maxConcurrent: 4,
  outputBufferChars: 65_536,
  quietMs: 60_000,
  startTimeoutMs: 10_000,
  graceMs: 3_000,
  killTimeoutMs: 5_000,
  snapshotTimeoutMs: 10_000,
  attestationTtlMs: 30_000,
  cols: 120,
  rows: 30,
});

const ms = z.number().int().min(1).max(3_600_000);
const limitsSchema = z.strictObject({
  maxConcurrent: z.number().int().min(1).max(32),
  outputBufferChars: z.number().int().min(1024).max(MAX_RING_CHARS),
  quietMs: ms,
  startTimeoutMs: ms,
  graceMs: ms,
  killTimeoutMs: ms,
  snapshotTimeoutMs: ms,
  attestationTtlMs: ms,
  cols: z.number().int().min(10).max(1000),
  rows: z.number().int().min(2).max(1000),
});

export function resolveLimits(overrides: Partial<RunLimits> | undefined): RunLimits {
  const merged: Record<string, unknown> = { ...DEFAULT_LIMITS };
  if (overrides !== undefined) {
    if (typeof overrides !== "object" || overrides === null) throw new AxisError("E_INVALID_ARGUMENT", "Invalid run limits");
    for (const [k, v] of Object.entries(overrides)) if (v !== undefined) merged[k] = v;
  }
  const parsed = limitsSchema.safeParse(merged);
  if (!parsed.success) {
    throw new AxisError("E_INVALID_ARGUMENT", `Invalid run limits: ${[...new Set(parsed.error.issues.map((i) => i.path.join(".")))].join(", ")}`);
  }
  return Object.freeze(parsed.data);
}
