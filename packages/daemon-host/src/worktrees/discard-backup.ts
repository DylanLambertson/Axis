// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { MAX_DISCARD_PATHS, MAX_UNBACKED_DISPLAY, MAX_UNBACKED_PATHS, toDisplayPath, type WorktreesResponse } from "@axis/protocol";
import { worktreeFailure } from "./errors.js";

/**
 * What a workspace backup cannot keep, as `@axis/worktrees` reports it (`DiscardScan`): files over the size limit, ignored
 * files and directories, and entries a snapshot cannot hold (nested repositories and the like).
 */
export interface UnbackedScan {
  readonly skippedLarge: readonly string[];
  readonly ignored: readonly string[];
  readonly skippedUnsupported: readonly string[];
}

const norm = (p: string): string => p.replace(/\/+$/, "").toLowerCase();

/**
 * The requested paths that would lose data a backup does not hold: a path that IS an unbacked entry, lies inside one (an
 * ignored directory), or is a directory that contains one. Compared case-insensitively, so a case-folding filesystem cannot
 * turn a refusal into a loss; the cost is a rare false refusal, which fails closed.
 */
export function unbackedAmong(scan: UnbackedScan, requested: readonly string[]): string[] {
  const entries = [...scan.skippedLarge, ...scan.ignored, ...scan.skippedUnsupported].map(norm);
  return requested.filter((raw) => {
    const p = norm(raw);
    return entries.some((e) => e === p || p.startsWith(`${e}/`) || e.startsWith(`${p}/`));
  });
}

/**
 * `discard` is tier 2, with no native dialog, and its backup does not hold every file, so a request that names a path the
 * backup cannot keep is refused (`E_CONFLICT`, reason `unbacked_data`) before anything is written. Nothing names the path.
 */
export function assertAllBacked(scan: UnbackedScan, requested: readonly string[]): void {
  if (unbackedAmong(scan, requested).length > 0) throw worktreeFailure("E_CONFLICT", "unbacked_data");
}

/** The reply's `unbacked` field for a confirmed discard: the total and the first few paths, escaped for display. */
export function unbackedSummary(unbacked: readonly string[]): NonNullable<WorktreesResponse<"discard">["unbacked"]> {
  return {
    count: Math.min(unbacked.length, MAX_DISCARD_PATHS),
    paths: unbacked.slice(0, MAX_UNBACKED_PATHS).map((p) => toDisplayPath(p, MAX_UNBACKED_DISPLAY)),
  };
}
