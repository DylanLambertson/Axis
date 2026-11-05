// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomUUID } from "node:crypto";
import {
  AuditActions,
  AuditLog,
  AxisError,
  InstanceLock,
  type AuditActor,
  runMigrations,
  withTransaction,
  type DatabaseSync,
} from "@axis/audit";
import { z } from "zod";
import {
  createRunSchema,
  createWorkspaceSchema,
  hashBody,
  idSchema,
  invalid,
  runStateSchema,
  toRun,
  toWorkspace,
  transitionOptionsSchema,
  workspaceStateSchema,
  type Created,
  type Project,
  type CreateRunInput,
  type CreateWorkspaceInput,
  type RecoveryReport,
  type Run,
  type RunRow,
  type Transition,
  type TransitionOptions,
  type Workspace,
  type WorkspaceRow,
} from "./model.js";
import {
  checkWorkspaceTransition,
  clearStaleLocks,
  getProject,
  listProjects,
  lockWorkspace,
  recordPushed,
  recordReviewedTree,
  registerProject,
  setWorktreePath,
  unlockWorkspace,
  type RecordsContext,
  type RegisterProjectInput,
} from "./records.js";
import { UserPrincipal } from "./principal.js";
import { JOURNAL_MIGRATIONS } from "./schema.js";
import {
  RESTART_REASON,
  RUN_STATES,
  RUN_TERMINAL_STATES,
  RUN_TRANSITIONS,
  WORKSPACE_TRANSITIONS,
  type RunState,
  type WorkspaceState,
} from "./states.js";

function inRecords<T>(db: DatabaseSync, audit: AuditLog, now: () => Date, fn: (ctx: RecordsContext) => T): T {
  return withTransaction(db, () => fn({ db, audit, ts: () => now().toISOString() }));
}

export interface JournalOptions {
  /**
   * Where recovery events go. It must be an `AuditLog` bound to the same
   * `DatabaseSync` handle as the journal (checked by `instanceof` and by
   * identity in `open`), so every change commits atomically with its audit
   * event.
   */
  readonly audit: AuditLog;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

const OPEN_RUN_STATES = RUN_STATES.filter((s) => !RUN_TERMINAL_STATES.includes(s));

/**
 * The durable journal for agent workspaces and runs. Every state change is a
 * single SQLite transaction (journal-first: the row and its transition record
 * commit together or not at all), so a process killed at any instant leaves
 * either the old state or the new one, never a mixture. `recover()` then
 * reconciles whatever the dead process left non-terminal.
 */
export class Journal {
  readonly #db: DatabaseSync;
  readonly #audit: AuditLog;
  readonly #now: () => Date;
  readonly #newId: () => string;

  private constructor(db: DatabaseSync, options: JournalOptions) {
    this.#db = db;
    this.#audit = options.audit;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => randomUUID());
  }

  /** Migrate the schema and return a journal. On daemon start take the instance lock, then call `recover(lock)`. */
  static open(db: DatabaseSync, options: JournalOptions): Journal {
    if (!(options.audit instanceof AuditLog) || !options.audit.isBoundTo(db)) {
      throw new AxisError(
        "E_INTERNAL",
        "The audit log must use the same database handle as the journal so state changes and audit events commit atomically",
      );
    }
    runMigrations(db, "journal", JOURNAL_MIGRATIONS);
    return new Journal(db, options);
  }

  // ---- workspaces ----

  createWorkspace(input: CreateWorkspaceInput): Created<Workspace> {
    const parsed = createWorkspaceSchema.safeParse(input);
    if (!parsed.success) throw invalid(parsed.error, "workspace");
    const { idempotencyKey: key, ...body } = parsed.data;
    return withTransaction(this.#db, () => {
      // The principal is part of the scope: one actor's key never resolves to another's result.
      const scope = `workspace.create:${body.createdBy}`;
      const replay = this.#replay(scope, key, body);
      if (replay) return { value: this.#mustWorkspace(replay), replayed: true };
      const id = this.#newId();
      const ts = this.#ts();
      this.#db
        .prepare(
          "INSERT INTO agent_workspaces (id, project_id, branch, base_ref, base_sha, created_by, state, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, 'CREATING', ?, ?)",
        )
        .run(id, body.projectId, body.branch, body.baseRef, body.baseSha, body.createdBy, ts, ts);
      this.#recordTransition("workspace", id, null, "CREATING", null, body.createdBy, ts);
      this.#remember(scope, key, body, id, ts);
      return { value: this.#mustWorkspace(id), replayed: false };
    });
  }

  getWorkspace(id: string): Workspace | undefined {
    const row = this.#db.prepare("SELECT * FROM agent_workspaces WHERE id = ?").get(id) as WorkspaceRow | undefined;
    return row ? toWorkspace(row) : undefined;
  }

  listWorkspaces(options: { readonly includeRemoved?: boolean } = {}): Workspace[] {
    const sql = options.includeRemoved
      ? "SELECT * FROM agent_workspaces ORDER BY created_at, id"
      : "SELECT * FROM agent_workspaces WHERE state NOT IN ('REMOVED','FAILED') ORDER BY created_at, id";
    return (this.#db.prepare(sql).all() as unknown as WorkspaceRow[]).map(toWorkspace);
  }

  transitionWorkspace(id: string, to: WorkspaceState, options: TransitionOptions = {}): Workspace {
    const target = workspaceStateSchema.safeParse(to);
    if (!target.success) throw invalid(target.error, "workspace state");
    const { opts } = this.#parseTransitionOptions(options);
    return withTransaction(this.#db, () => {
      const current = this.#mustWorkspace(id);
      this.#guard("workspace", current.state, to, WORKSPACE_TRANSITIONS[current.state], opts.expectedFrom);
      checkWorkspaceTransition(this.#db, id, current.state, to, opts.outcome);
      const ts = this.#ts();
      this.#expectOne(
        this.#db
          .prepare(
            "UPDATE agent_workspaces SET state = ?, reconcile_reported = 0, updated_at = ?, finalise_outcome = COALESCE(?, finalise_outcome), " +
              "lock_state = CASE WHEN ? IN ('REMOVED','FAILED') THEN 'unlocked' ELSE lock_state END, " +
              "locked_at = CASE WHEN ? IN ('REMOVED','FAILED') THEN NULL ELSE locked_at END WHERE id = ? AND state = ?",
          )
          .run(to, ts, opts.outcome ?? null, to, to, id, current.state),
      );
      this.#recordTransition("workspace", id, current.state, to, opts.reason ?? null, opts.actor ?? "daemon", ts);
      return this.#mustWorkspace(id);
    });
  }

  // ---- host records (projects, worktree path, lock, last pushed sha, reviewed tree): each with its audit event, one transaction ----

  registerProject(input: RegisterProjectInput): Project {
    return inRecords(this.#db, this.#audit, this.#now, (ctx) => registerProject(ctx, input));
  }
  getProject(id: string): Project | undefined {
    return getProject(this.#db, id);
  }
  listProjects(): Project[] {
    return listProjects(this.#db);
  }
  setWorktreePath(id: string, path: string, actor: AuditActor): Workspace {
    return inRecords(this.#db, this.#audit, this.#now, (ctx) => setWorktreePath(ctx, id, path, actor));
  }
  lockWorkspace(id: string, actor: AuditActor): Workspace {
    return inRecords(this.#db, this.#audit, this.#now, (ctx) => lockWorkspace(ctx, id, actor));
  }
  unlockWorkspace(id: string, actor: AuditActor): Workspace {
    return inRecords(this.#db, this.#audit, this.#now, (ctx) => unlockWorkspace(ctx, id, actor));
  }
  recordPushed(id: string, sha: string, actor: AuditActor): Workspace {
    return inRecords(this.#db, this.#audit, this.#now, (ctx) => recordPushed(ctx, id, sha, actor));
  }
  recordReviewedTree(id: string, treeHash: string, principal: UserPrincipal): Workspace {
    return inRecords(this.#db, this.#audit, this.#now, (ctx) => recordReviewedTree(ctx, id, treeHash, principal));
  }

  // ---- runs ----

  createRun(input: CreateRunInput): Created<Run> {
    const parsed = createRunSchema.safeParse(input);
    if (!parsed.success) throw invalid(parsed.error, "run");
    const { idempotencyKey: key, ...body } = parsed.data;
    const { createdBy } = body;
    return withTransaction(this.#db, () => {
      const scope = `run.create:${createdBy}`;
      const replay = this.#replay(scope, key, body);
      if (replay) return { value: this.#mustRun(replay), replayed: true };
      const workspace = this.#mustWorkspace(body.workspaceId);
      if (workspace.state !== "READY") {
        throw new AxisError("E_CONFLICT", "Runs can only be created in a READY workspace", { state: workspace.state });
      }
      const id = this.#newId();
      const ts = this.#ts();
      this.#db
        .prepare(
          "INSERT INTO agent_runs (id, workspace_id, kind, state, created_at, updated_at) VALUES (?, ?, ?, 'QUEUED', ?, ?)",
        )
        .run(id, body.workspaceId, body.kind, ts, ts);
      this.#recordTransition("run", id, null, "QUEUED", null, createdBy, ts);
      this.#remember(scope, key, body, id, ts);
      return { value: this.#mustRun(id), replayed: false };
    });
  }

  getRun(id: string): Run | undefined {
    const row = this.#db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  listRuns(options: { readonly workspaceId?: string; readonly states?: readonly RunState[] } = {}): Run[] {
    const where: string[] = [];
    const args: string[] = [];
    if (options.workspaceId !== undefined) {
      const w = idSchema.safeParse(options.workspaceId);
      if (!w.success) throw invalid(w.error, "workspace id");
      where.push("workspace_id = ?");
      args.push(w.data);
    }
    if (options.states !== undefined) {
      if (options.states.length === 0) return [];
      const parsedStates = z.array(runStateSchema).max(RUN_STATES.length).safeParse(options.states);
      if (!parsedStates.success) throw invalid(parsedStates.error, "run states");
      const states = parsedStates.data;
      where.push(`state IN (${states.map(() => "?").join(",")})`);
      args.push(...states);
    }
    const sql = `SELECT * FROM agent_runs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`;
    return (this.#db.prepare(sql).all(...args) as unknown as RunRow[]).map(toRun);
  }

  transitionRun(id: string, to: RunState, options: TransitionOptions = {}): Run {
    const target = runStateSchema.safeParse(to);
    if (!target.success) throw invalid(target.error, "run state");
    const { opts, approvedByUser } = this.#parseTransitionOptions(options);
    if (opts.outcome !== undefined) throw new AxisError("E_INVALID_ARGUMENT", "An outcome applies only to finalising a workspace");
    return withTransaction(this.#db, () => {
      const current = this.#mustRun(id);
      this.#guard("run", current.state, to, RUN_TRANSITIONS[current.state], opts.expectedFrom);
      // Approval is a human act in 1a (diff review, threat model WT-5): an agent, or the daemon on its own, cannot approve its own work.
      // The string "user" does not count: only the principal the daemon minted from the attested connection does.
      if (current.state === "REVIEWING" && to === "COMPLETED" && !approvedByUser) {
        throw new AxisError("E_POLICY_DENIED", "Only the user, acting through the daemon, can complete a run that is in review");
      }
      if (current.state === "BLOCKED" && (to === "QUEUED" || to === "RUNNING")) {
        const ws = this.#mustWorkspace(current.workspaceId);
        if (ws.state !== "READY") {
          throw new AxisError("E_CONFLICT", "A run can only resume in a READY workspace", { state: ws.state });
        }
      }
      const ts = this.#ts();
      const terminal = RUN_TERMINAL_STATES.includes(to);
      this.#expectOne(
        this.#db
          .prepare(
            "UPDATE agent_runs SET state = ?, reason = ?, exit_code = COALESCE(?, exit_code), updated_at = ?, " +
              "started_at = CASE WHEN ? = 'RUNNING' AND started_at IS NULL THEN ? ELSE started_at END, " +
              "ended_at = CASE WHEN ? THEN ? ELSE ended_at END WHERE id = ? AND state = ?",
          )
          .run(to, opts.reason ?? null, opts.exitCode ?? null, ts, to, ts, terminal ? 1 : 0, ts, id, current.state),
      );
      this.#recordTransition("run", id, current.state, to, opts.reason ?? null, opts.actor ?? "daemon", ts);
      return this.#mustRun(id);
    });
  }

  /** Transition history for a workspace or run, oldest first. */
  transitions(entity: "workspace" | "run", entityId: string): Transition[] {
    const rows = this.#db
      .prepare(
        "SELECT entity, entity_id, from_state, to_state, reason, actor, ts FROM state_transitions WHERE entity = ? AND entity_id = ? ORDER BY id",
      )
      .all(entity, entityId) as unknown as Array<{
      entity: "workspace" | "run";
      entity_id: string;
      from_state: string | null;
      to_state: string;
      reason: string | null;
      actor: string;
      ts: string;
    }>;
    return rows.map((r) => ({
      entity: r.entity,
      entityId: r.entity_id,
      from: r.from_state,
      to: r.to_state,
      reason: r.reason,
      actor: r.actor,
      ts: r.ts,
    }));
  }

  // ---- recovery (DMN-7) ----

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
  recover(lock: InstanceLock): RecoveryReport {
    // A genuine lock (not a lookalike literal), still held, for this database's own directory.
    if (!InstanceLock.is(lock)) {
      throw new AxisError("E_INVALID_ARGUMENT", "Recovery requires an instance lock from acquireInstanceLock");
    }
    if (!lock.held) throw new AxisError("E_CONFLICT", "Recovery requires the held single-instance lock");
    if (!lock.guards(this.#db)) {
      throw new AxisError("E_INVALID_ARGUMENT", "The instance lock does not guard this database's directory");
    }
    return withTransaction(this.#db, () => {
      const ts = this.#ts();
      // First, so a CREATING workspace that holds a stale lock is reported as unlocked before it becomes FAILED.
      const locksCleared = clearStaleLocks({ db: this.#db, audit: this.#audit, ts: () => ts });
      const runsInterrupted: string[] = [];
      const workspacesFailed: string[] = [];
      const workspacesNeedingReconcile: string[] = [];
      const runsLeftAlone: string[] = [];

      const stuckWorkspaces = this.#db
        .prepare("SELECT * FROM agent_workspaces WHERE state IN ('CREATING','REMOVING') ORDER BY created_at, id")
        .all() as unknown as WorkspaceRow[];
      for (const row of stuckWorkspaces) {
        if (row.state === "CREATING") {
          this.#expectOne(
            this.#db
              .prepare("UPDATE agent_workspaces SET state = 'FAILED', updated_at = ? WHERE id = ? AND state = 'CREATING'")
              .run(ts, row.id),
          );
          this.#recordTransition("workspace", row.id, "CREATING", "FAILED", RESTART_REASON, "daemon", ts);
          this.#audit.append({
            actor: "daemon",
            action: AuditActions.journalRecovery,
            target: `workspace:${row.id}`,
            outcome: "success",
            payload: { from: "CREATING", to: "FAILED", reason: RESTART_REASON, projectId: row.project_id },
          });
          workspacesFailed.push(row.id);
        } else {
          workspacesNeedingReconcile.push(row.id);
          if (row.reconcile_reported === 0) {
            this.#expectOne(
              this.#db.prepare("UPDATE agent_workspaces SET reconcile_reported = 1 WHERE id = ? AND state = 'REMOVING'").run(row.id),
            );
            this.#audit.append({
              actor: "daemon",
              action: AuditActions.journalRecovery,
              target: `workspace:${row.id}`,
              outcome: "success",
              payload: { from: "REMOVING", to: "REMOVING", reason: "NEEDS_RECONCILE", projectId: row.project_id },
            });
          }
        }
      }

      const nonTerminalRuns = this.#db
        .prepare(`SELECT * FROM agent_runs WHERE state IN (${OPEN_RUN_STATES.map(() => "?").join(",")}) ORDER BY created_at, id`)
        .all(...OPEN_RUN_STATES) as unknown as RunRow[];
      for (const row of nonTerminalRuns) {
        if (row.state !== "RUNNING") {
          runsLeftAlone.push(row.id);
          continue;
        }
        this.#expectOne(
          this.#db
            .prepare("UPDATE agent_runs SET state = 'BLOCKED', reason = ?, updated_at = ? WHERE id = ? AND state = 'RUNNING'")
            .run(RESTART_REASON, ts, row.id),
        );
        this.#recordTransition("run", row.id, "RUNNING", "BLOCKED", RESTART_REASON, "daemon", ts);
        this.#audit.append({
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

  // ---- internals ----

  #ts(): string {
    return this.#now().toISOString();
  }

  /** Validate the options. A genuine `UserPrincipal` becomes the actor "user" and sets `approvedByUser`; nothing else can. */
  #parseTransitionOptions(options: TransitionOptions): {
    readonly opts: Omit<TransitionOptions, "actor"> & { readonly actor?: AuditActor };
    readonly approvedByUser: boolean;
  } {
    const record = typeof options === "object" && options !== null ? options : {};
    const approvedByUser = UserPrincipal.is(record.actor);
    // An object that is not a genuine principal is a forgery attempt (a literal, a prototype lookalike, a clone), not a typo.
    if (!approvedByUser && typeof record.actor === "object" && record.actor !== null) {
      throw new AxisError("E_POLICY_DENIED", "An actor must be a plain actor name or a principal minted by the daemon");
    }
    const parsed = transitionOptionsSchema.safeParse(approvedByUser ? { ...record, actor: "user" } : record);
    if (!parsed.success) throw invalid(parsed.error, "transition options");
    return { opts: parsed.data as Omit<TransitionOptions, "actor"> & { readonly actor?: AuditActor }, approvedByUser };
  }

  /** A single-row UPDATE that touched anything else means the caller's assumptions broke: fail loudly. */
  #expectOne(result: { changes: number | bigint }): void {
    if (Number(result.changes) !== 1) throw new AxisError("E_INTERNAL", "A state update did not apply to exactly one row");
  }

  #guard(entity: string, from: string, to: string, allowed: readonly string[], expectedFrom: string | undefined): void {
    if (expectedFrom !== undefined && expectedFrom !== from) {
      throw new AxisError("E_CONFLICT", `The ${entity} is no longer in the expected state`, { expected: expectedFrom, actual: from });
    }
    if (!allowed.includes(to)) {
      throw new AxisError("E_CONFLICT", `Illegal ${entity} transition ${from} -> ${to}`, { from, to });
    }
  }

  #recordTransition(
    entity: "workspace" | "run",
    id: string,
    from: string | null,
    to: string,
    reason: string | null,
    actor: string,
    ts: string,
  ): void {
    this.#db
      .prepare("INSERT INTO state_transitions (entity, entity_id, from_state, to_state, reason, actor, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(entity, id, from, to, reason, actor, ts);
  }

  /** Returns the earlier result id for a replayed key, throws on a key reused with different input. */
  #replay(scope: string, key: string | undefined, body: unknown): string | undefined {
    if (key === undefined) return undefined;
    const row = this.#db.prepare("SELECT request_hash, result_id FROM idempotency WHERE scope = ? AND key = ?").get(scope, key) as
      | { request_hash: string; result_id: string }
      | undefined;
    if (!row) return undefined;
    if (row.request_hash !== hashBody(body)) {
      throw new AxisError("E_IDEMPOTENCY_CONFLICT", "That idempotency key was already used with a different request");
    }
    return row.result_id;
  }

  #remember(scope: string, key: string | undefined, body: unknown, resultId: string, ts: string): void {
    if (key === undefined) return;
    this.#db
      .prepare("INSERT INTO idempotency (scope, key, request_hash, result_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(scope, key, hashBody(body), resultId, ts);
  }

  #mustWorkspace(id: string): Workspace {
    const w = this.getWorkspace(id);
    if (!w) throw new AxisError("E_NOT_FOUND", "Workspace not found");
    return w;
  }

  #mustRun(id: string): Run {
    const r = this.getRun(id);
    if (!r) throw new AxisError("E_NOT_FOUND", "Run not found");
    return r;
  }
}
