// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { ProcessOps, PtySignal } from "./ports.js";

export type GroupState = "alive" | "gone";

function errnoCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
}

/** A pgid Axis may signal: a real group, never 0 (own group), 1 (init) or anything that would turn `-pgid` into "every process". */
export function validPgid(pgid: unknown): pgid is number {
  return typeof pgid === "number" && Number.isSafeInteger(pgid) && pgid > 1;
}

/**
 * `kill(-pgid, 0)`: success or EPERM means a process of the group exists, ESRCH means none. Any other error is unknown and
 * rethrown, so the caller (PtyHandle contract) counts it as alive.
 */
export function probeGroup(ops: ProcessOps, pgid: number): GroupState {
  if (!validPgid(pgid)) throw new Error("invalid process group");
  try {
    ops.signal(-pgid, 0);
    return "alive";
  } catch (e) {
    const code = errnoCode(e);
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "alive";
    throw e;
  }
}

/** Signals the whole group, only while the group answers the probe (a reused pgid of a finished group is never hit blind). ESRCH is success. */
export function signalGroup(ops: ProcessOps, pgid: number, signal: PtySignal): GroupState {
  if (probeGroup(ops, pgid) === "gone") return "gone";
  try {
    ops.signal(-pgid, signal);
  } catch (e) {
    if (errnoCode(e) === "ESRCH") return "gone";
    throw e;
  }
  return "alive";
}
