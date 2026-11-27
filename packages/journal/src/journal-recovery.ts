// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AuditActions, AxisError, InstanceLock, withTransaction, type AuditActor, type AuditLog, type DatabaseSync } from "@axis/audit";
import type { AgentRecords } from "./agent-store.js";
import type { RecoveryReport, RunRow, WorkspaceRow } from "./model.js";
import { clearStaleLocks } from "./records.js";
import { RESTART_REASON, RUN_STATES, RUN_TERMINAL_STATES } from "./states.js";

/** `Journal.recover` (DMN-7), moved out of `journal.ts` unchanged (ticket PV-X2): `j` is the journal's own internals. */
export interface RecoveryInternals {
  readonly db: DatabaseSync;
  readonly audit: AuditLog;
  readonly agents: Pick<AgentRecords, "liveOn" | "noteArchivedWithHome">;
  ts(): string;
  expectOne(result: { changes: number | bigint }): void;
  recordTransition(entity: "workspace" | "run", id: string, from: string | null, to: string, reason: string | null, actor: AuditActor | string, ts: string): void;
}

const OPEN_RUN_STATES = RUN_STATES.filter((s) => !RUN_TERMINAL_STATES.includes(s));

/**
 * Reconcile after a start. Requires the held instance lock
 * (`acquireInstanceLock`, an `InstanceLock` object, not a lookalike) for the
 * directory of this journal's database: a second live daemon on the same data must never
 * run this, because it would block the first one's RUNNING runs. Policy:
 *
 * - run RUNNING            -> BLOCKED / INTERRUPTED_BY_RESTART (the composer loop or the CLI supervision is gone);
 * - workspace CREATING     -> FAILED / INTERRUPTED_BY_RESTART (the worktree manager sweeps any stray Git worktree);
 * - workspace REMOVING     -> unchanged; reported on every call, audited once;
 * - run QUEUED/REVIEWING/BLOCKED -> unchanged (durable states a person or the scheduler acts on);
 * - workspace lock_state locked -> unlocked (the process that took it is gone).
 *
 * One transaction: each change is written with its transition record and a
 * `journal.recovery` audit event, all or nothing. Converges: a second call
 * after a completed recovery changes nothing and writes nothing, and a call
 * after a crash (including one during recovery) finishes the job.
 */
export function recoverJournal(j: RecoveryInternals, lock: InstanceLock): RecoveryReport {
  // A genuine lock (not a lookalike literal), still held, for this database's own directory.
  if (!InstanceLock.is(lock)) {
    throw new AxisError("E_INVALID_ARGUMENT", "Recovery requires an instance lock from acquireInstanceLock");
  }
  if (!lock.held) throw new AxisError("E_CONFLICT", "Recovery requires the held single-instance lock");
  if (!lock.guards(j.db)) {
    throw new AxisError("E_INVALID_ARGUMENT", "The instance lock does not guard this database's directory");
  }
  return withTransaction(j.db, () => {
    const ts = j.ts();
    // First, so a CREATING workspace that holds a stale lock is reported as unlocked before it becomes FAILED.
    const locksCleared = clearStaleLocks({ db: j.db, audit: j.audit, ts: () => ts });
    const runsInterrupted: string[] = [];
    const workspacesFailed: string[] = [];
    const workspacesNeedingReconcile: string[] = [];
    const runsLeftAlone: string[] = [];

    const stuckWorkspaces = j.db
      .prepare("SELECT * FROM agent_workspaces WHERE state IN ('CREATING','REMOVING') ORDER BY created_at, id")
      .all() as unknown as WorkspaceRow[];
    for (const row of stuckWorkspaces) {
      if (row.state === "CREATING") {
        const homed = j.agents.liveOn(row.id);
        j.expectOne(
          j.db
            .prepare("UPDATE agent_workspaces SET state = 'FAILED', updated_at = ? WHERE id = ? AND state = 'CREATING'")
            .run(ts, row.id),
        );
        j.recordTransition("workspace", row.id, "CREATING", "FAILED", RESTART_REASON, "daemon", ts);
        j.audit.append({
          actor: "daemon",
          action: AuditActions.journalRecovery,
          target: `workspace:${row.id}`,
          outcome: "success",
          payload: { from: "CREATING", to: "FAILED", reason: RESTART_REASON, projectId: row.project_id },
        });
        j.agents.noteArchivedWithHome(homed, row.id, "daemon");
        workspacesFailed.push(row.id);
      } else {
        workspacesNeedingReconcile.push(row.id);
        if (row.reconcile_reported === 0) {
          j.expectOne(
            j.db.prepare("UPDATE agent_workspaces SET reconcile_reported = 1 WHERE id = ? AND state = 'REMOVING'").run(row.id),
          );
          j.audit.append({
            actor: "daemon",
            action: AuditActions.journalRecovery,
            target: `workspace:${row.id}`,
            outcome: "success",
            payload: { from: "REMOVING", to: "REMOVING", reason: "NEEDS_RECONCILE", projectId: row.project_id },
          });
        }
      }
    }

    const nonTerminalRuns = j.db
      .prepare(`SELECT * FROM agent_runs WHERE state IN (${OPEN_RUN_STATES.map(() => "?").join(",")}) ORDER BY created_at, id`)
      .all(...OPEN_RUN_STATES) as unknown as RunRow[];
    for (const row of nonTerminalRuns) {
      if (row.state !== "RUNNING") {
        runsLeftAlone.push(row.id);
        continue;
      }
      j.expectOne(
        j.db
          .prepare("UPDATE agent_runs SET state = 'BLOCKED', reason = ?, updated_at = ? WHERE id = ? AND state = 'RUNNING'")
          .run(RESTART_REASON, ts, row.id),
      );
      j.recordTransition("run", row.id, "RUNNING", "BLOCKED", RESTART_REASON, "daemon", ts);
      j.audit.append({
        actor: "daemon",
        action: AuditActions.journalRecovery,
        target: `run:${row.id}`,
        outcome: "success",
        payload: { from: "RUNNING", to: "BLOCKED", reason: RESTART_REASON, kind: row.kind, workspaceId: row.workspace_id },
      });
      runsInterrupted.push(row.id);
    }
    return { runsInterrupted, workspacesFailed, workspacesNeedingReconcile, runsLeftAlone, locksCleared };
  });
}
