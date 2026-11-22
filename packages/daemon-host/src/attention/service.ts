// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { ATTENTION_COUNT_CAP, ATTENTION_MAX_AGENTS, type AttentionCount, type AttentionSummary } from "@axis/protocol";

/**
 * The needs-attention summary of one project (ticket PV-D4, `axis.attention/1.summary`, docs/design/product-vision-v2.md
 * §3.4). A read: it only asks the journal and the live run services, and it answers ids and counts. Each journal read takes
 * at most `ATTENTION_SCAN_ROWS` rows, so the work is bounded whatever the tables hold; a scan that fills its window reports
 * the counts derived from it as capped ("999+": at least that many may need attention).
 */
export const ATTENTION_SCAN_ROWS = ATTENTION_COUNT_CAP + 1;

/** A run as the journal's attention reads return it (`AttentionRecords` of `@axis/journal`). */
export interface AttentionRunRow {
  readonly runId: string;
  readonly kind: "composer" | "cli";
  readonly state: string;
  readonly agentId: string | null;
}

export interface AttentionServiceDeps {
  readonly projectExists: (projectId: string) => boolean;
  readonly records: {
    latestRuns(projectId: string, limit: number): readonly AttentionRunRow[];
    runningRuns(projectId: string, limit: number): readonly AttentionRunRow[];
    unreadForUser(projectId: string, limit: number): number;
  };
  /** The CLI run as the run supervisor reports it now (`status`, `snapshotAfter`); it may throw for an unknown run. */
  readonly cliRun: (runId: string) => { readonly status: string; readonly snapshotAfter: string };
  /** The composer run as the composer service reports it now; it may throw for an unknown run. */
  readonly composerRun: (runId: string) => { readonly awaitingApproval: boolean };
}

export interface AttentionService {
  summary(projectId: string): AttentionSummary;
}

/** The one refusal: the project is not registered. The handler answers it exactly as a refused caller. */
export class AttentionRefusal extends Error {
  constructor() {
    super("attention refused");
    this.name = "AttentionRefusal";
  }
}

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/** `n` saturated at the cap; `capped` when the true value is above it, or may be (`more`: the scan window was full). */
export function countOf(n: number, more = false): AttentionCount {
  return n > ATTENTION_COUNT_CAP || more ? { n: ATTENTION_COUNT_CAP, capped: true } : { n, capped: false };
}

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

export function createAttentionService(deps: AttentionServiceDeps): AttentionService {
  return {
    summary(projectId) {
      if (!deps.projectExists(projectId)) throw new AttentionRefusal();
      const latest = deps.records.latestRuns(projectId, ATTENTION_SCAN_ROWS);
      const running = deps.records.runningRuns(projectId, ATTENTION_SCAN_ROWS);
      const latestFull = latest.length >= ATTENTION_SCAN_ROWS;
      const runningFull = running.length >= ATTENTION_SCAN_ROWS;

      // Live: a composer loop waiting on a confirmation, per agent. Nothing of the challenge is read.
      const waiting = new Map<string | null, number>();
      let quiet = 0;
      for (const r of running) {
        if (r.kind === "composer") {
          if (attempt(() => deps.composerRun(r.runId))?.awaitingApproval === true) waiting.set(r.agentId, (waiting.get(r.agentId) ?? 0) + 1);
        } else if (attempt(() => deps.cliRun(r.runId))?.status === "quiet") {
          quiet++;
        }
      }

      // Durable: the newest run of a live workspace failed. Live verdict: an ended CLI run whose snapshot is not `ok`
      // (`drift`, or `unknown` after a restart or a snapshot that did not answer: possibly changed, WT-2) is a drift flag.
      let failed = 0;
      let drift = 0;
      for (const r of latest) {
        if (r.state === "FAILED") failed++;
        if (r.kind === "cli" && TERMINAL.has(r.state)) {
          const after = attempt(() => deps.cliRun(r.runId))?.snapshotAfter;
          if (after !== "ok") drift++;
        }
      }

      const unread = deps.records.unreadForUser(projectId, ATTENTION_SCAN_ROWS);
      const agents = [...waiting.entries()].sort(([a], [b]) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1));
      const total = agents.reduce((t, [, n]) => t + n, 0);
      return {
        projectId,
        approvalsWaiting: {
          total: countOf(total, runningFull),
          byAgent: agents.slice(0, ATTENTION_MAX_AGENTS).map(([agentId, n]) => ({ agentId, n: Math.min(n, ATTENTION_COUNT_CAP) })),
          more: agents.length > ATTENTION_MAX_AGENTS,
        },
        failedRuns: countOf(failed, latestFull),
        quietCliRuns: countOf(quiet, runningFull),
        driftFlags: countOf(drift, latestFull),
        unreadMessages: countOf(unread, unread >= ATTENTION_SCAN_ROWS),
      };
    },
  };
}
