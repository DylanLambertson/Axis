// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { RunState } from "@axis/journal";

/** Reason codes this package writes to the journal. Short upper-case codes, never free text. */
export const RUN_REASONS = {
  exited: "PROCESS_EXITED",
  nonZero: "EXIT_NONZERO",
  signalled: "SIGNALLED",
  unknownExit: "EXIT_UNKNOWN",
  userKilled: "USER_KILLED",
  killUnconfirmed: "KILL_UNCONFIRMED",
  spawnFailed: "SPAWN_FAILED",
  spawnTimeout: "SPAWN_TIMEOUT",
  snapshotFailed: "SNAPSHOT_FAILED",
  auditFailed: "AUDIT_FAILED",
  launchRefused: "LAUNCH_REFUSED",
  journalFailed: "JOURNAL_FAILED",
  internal: "INTERNAL_ERROR",
  userDiscarded: "USER_DISCARDED",
} as const;

/** A `CANCELLED` row with one of these reasons is a launch or run that failed, not one the user stopped. */
const FAILURE_REASONS: ReadonlySet<string> = new Set([
  RUN_REASONS.spawnFailed,
  RUN_REASONS.spawnTimeout,
  RUN_REASONS.snapshotFailed,
  RUN_REASONS.auditFailed,
  RUN_REASONS.launchRefused,
  RUN_REASONS.journalFailed,
  RUN_REASONS.internal,
]);

export const RUN_STATUSES = ["starting", "running", "quiet", "finished", "failed", "killed", "interrupted"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const WORKSPACE_RUN_STATUSES = ["idle", "running", "quiet", "failed", "done"] as const;
export type WorkspaceRunStatus = (typeof WORKSPACE_RUN_STATUSES)[number];

/** What the supervisor knows about a process it owns. `undefined` means there is none in this process. */
export interface LiveView {
  readonly phase: "starting" | "running" | "stopping";
  /** Clock time of the last output, or of the start when there has been none. */
  readonly lastActivityAt: number;
}

export interface StatusInput {
  readonly state: RunState;
  readonly reason: string | null;
  readonly live: LiveView | undefined;
  readonly now: number;
  readonly quietMs: number;
}

/**
 * The dashboard status of one run, from the journal state plus the process state this daemon owns, and nothing
 * else (Axis never parses CLI output). A journal row that says the run is going while no process is held here is
 * `interrupted`: Axis does not report a process it cannot see.
 */
export function deriveStatus(i: StatusInput): RunStatus {
  switch (i.state) {
    case "QUEUED":
      return i.live ? "starting" : "interrupted";
    case "RUNNING":
      if (!i.live) return "interrupted";
      if (i.live.phase === "starting") return "starting";
      return i.now - i.live.lastActivityAt >= i.quietMs ? "quiet" : "running";
    case "REVIEWING":
    case "COMPLETED":
      return "finished";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      if (i.reason !== null && FAILURE_REASONS.has(i.reason)) return "failed";
      return i.reason === "INTERRUPTED_BY_RESTART" ? "interrupted" : "killed";
    case "BLOCKED":
      return "interrupted";
  }
}

/**
 * The workspace row: a live run wins (`quiet` only when every live run is quiet), else the latest run decides.
 * A stopped run leaves the workspace `idle`.
 */
export function deriveWorkspaceStatus(runs: readonly { readonly status: RunStatus; readonly createdAt: string }[]): WorkspaceRunStatus {
  if (runs.length === 0) return "idle";
  const active = runs.filter((r) => r.status === "starting" || r.status === "running" || r.status === "quiet");
  if (active.length > 0) return active.every((r) => r.status === "quiet") ? "quiet" : "running";
  let latest = runs[0] as (typeof runs)[number];
  for (const r of runs) if (r.createdAt >= latest.createdAt) latest = r;
  switch (latest.status) {
    case "failed":
    case "interrupted":
      return "failed";
    case "finished":
      return "done";
    default:
      return "idle";
  }
}
