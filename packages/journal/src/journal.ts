// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash, randomUUID } from "node:crypto";
import {
  AuditActions,
  AxisError,
  canonicalize,
  runMigrations,
  withTransaction,
  type AuditActor,
  type AuditLog,
  type DatabaseSync,
} from "@axis/audit";
import { z } from "zod";
import { JOURNAL_MIGRATIONS } from "./schema.js";
import {
  RESTART_REASON,
  RUN_KINDS,
  RUN_TERMINAL_STATES,
  RUN_TRANSITIONS,
  WORKSPACE_TRANSITIONS,
  type RunKind,
  type RunState,
  type WorkspaceState,
} from "./states.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const ACTOR = /^(?:user|daemon|agent:[A-Za-z0-9._-]{1,64})$/;
const noControl = (s: string): boolean => !/[\u0000-\u001f\u007f]/.test(s);
const text = (max: number) => z.string().min(1).max(max).refine(noControl);

const idempotencyKey = z.string().regex(UUID_V4);
const actorSchema = z.string().regex(ACTOR);

const createWorkspaceSchema = z
  .object({
    projectId: text(128),
    branch: text(256),
    baseRef: text(256),
    baseSha: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
    createdBy: actorSchema,
    idempotencyKey: idempotencyKey.optional(),
  })
  .strict();

const createRunSchema = z
  .object({
    workspaceId: text(128),
    kind: z.enum(RUN_KINDS),
    createdBy: actorSchema.optional(),
    idempotencyKey: idempotencyKey.optional(),
  })
  .strict();

const transitionOptionsSchema = z
  .object({
    reason: z.string().regex(REASON).optional(),
    actor: actorSchema.optional(),
    exitCode: z.number().int().min(-255).max(255).optional(),
    /** Optimistic guard: the transition applies only if the entity is in this state. */
    expectedFrom: z.string().optional(),
  })
  .strict();

export interface Workspace {
  readonly id: string;
  readonly projectId: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly createdBy: string;
  readonly state: WorkspaceState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Run {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: RunKind;
  readonly state: RunState;
  readonly reason: string | null;
  readonly exitCode: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

export interface Transition {
  readonly entity: "workspace" | "run";
  readonly entityId: string;
  readonly from: string | null;
  readonly to: string;
  readonly reason: string | null;
  readonly actor: string;
  readonly ts: string;
}

export interface CreateWorkspaceInput {
  readonly projectId: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly createdBy: AuditActor;
  /** UUIDv4. A replay with the same input returns the same workspace. */
  readonly idempotencyKey?: string;
}

export interface CreateRunInput {
  readonly workspaceId: string;
  readonly kind: RunKind;
  readonly createdBy?: AuditActor;
  readonly idempotencyKey?: string;
}

export interface TransitionOptions {
  /** Short upper-case code (for example `USER_CANCELLED`); never free text, so no secret can ride along. */
  readonly reason?: string;
  readonly actor?: AuditActor;
  readonly exitCode?: number;
  readonly expectedFrom?: string;
}

export interface Created<T> {
  readonly value: T;
  /** True when an earlier call with the same idempotency key already created it. */
  readonly replayed: boolean;
}

export interface RecoveryReport {
  /** Runs that were RUNNING and are now BLOCKED (`INTERRUPTED_BY_RESTART`). */
  readonly runsInterrupted: readonly string[];
  /** Workspaces that were CREATING and are now FAILED. */
  readonly workspacesFailed: readonly string[];
  /**
   * Workspaces left in REMOVING. Removal is idempotent against Git, so the
   * worktree manager finishes or rolls back from here; no state change is made.
   */
  readonly workspacesNeedingReconcile: readonly string[];
  /** Non-terminal runs recovery left alone (QUEUED, REVIEWING, BLOCKED): they are durable user-facing states. */
  readonly runsLeftAlone: readonly string[];
}

export interface JournalOptions {
  /**
   * Where recovery events go. It must be an `AuditLog` bound to the same
   * `DatabaseSync` handle as the journal (checked by identity in `open`), so
   * every change commits atomically with its audit event.
   */
  readonly audit: AuditLog;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

interface WorkspaceRow {
  id: string;
  project_id: string;
  branch: string;
  base_ref: string;
  base_sha: string;
  created_by: string;
  state: string;
  created_at: string;
  updated_at: string;
}
interface RunRow {
  id: string;
  workspace_id: string;
  kind: string;
  state: string;
  reason: string | null;
  exit_code: number | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;
}

const toWorkspace = (r: WorkspaceRow): Workspace => ({
  id: r.id,
  projectId: r.project_id,
  branch: r.branch,
  baseRef: r.base_ref,
  baseSha: r.base_sha,
  createdBy: r.created_by,
  state: r.state as WorkspaceState,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toRun = (r: RunRow): Run => ({
  id: r.id,
  workspaceId: r.workspace_id,
  kind: r.kind as RunKind,
  state: r.state as RunState,
  reason: r.reason,
  exitCode: r.exit_code,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

function invalid(error: z.ZodError, what: string): AxisError {
  // Only field paths: zod messages can echo the offending value.
  const fields = [...new Set(error.issues.map((i) => i.path.join(".") || "(root)"))].join(", ");
  return new AxisError("E_INVALID_ARGUMENT", `Invalid ${what}: ${fields}`);
}

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

  /** Migrate the schema and return a journal. Call `recover()` next on daemon start. */
  static open(db: DatabaseSync, options: JournalOptions): Journal {
    if (!options.audit.isBoundTo(db)) {
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
      const replay = this.#replay("workspace.create", key, body);
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
      this.#remember("workspace.create", key, body, id, ts);
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
    const opts = this.#parseTransitionOptions(options);
    return withTransaction(this.#db, () => {
      const current = this.#mustWorkspace(id);
      this.#guard("workspace", current.state, to, WORKSPACE_TRANSITIONS[current.state], opts.expectedFrom);
      const ts = this.#ts();
      this.#db.prepare("UPDATE agent_workspaces SET state = ?, updated_at = ? WHERE id = ? AND state = ?").run(to, ts, id, current.state);
      this.#recordTransition("workspace", id, current.state, to, opts.reason ?? null, opts.actor ?? "daemon", ts);
      return this.#mustWorkspace(id);
    });
  }

  // ---- runs ----

  createRun(input: CreateRunInput): Created<Run> {
    const parsed = createRunSchema.safeParse(input);
    if (!parsed.success) throw invalid(parsed.error, "run");
    const { idempotencyKey: key, createdBy, ...body } = parsed.data;
    return withTransaction(this.#db, () => {
      const replay = this.#replay("run.create", key, body);
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
      this.#recordTransition("run", id, null, "QUEUED", null, createdBy ?? "user", ts);
      this.#remember("run.create", key, body, id, ts);
      return { value: this.#mustRun(id), replayed: false };
    });
  }

  getRun(id: string): Run | undefined {
    const row = this.#db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  listRuns(options: { readonly workspaceId?: string; readonly states?: readonly RunState[] } = {}): Run[] {
    const rows = this.#db.prepare("SELECT * FROM agent_runs ORDER BY created_at, id").all() as unknown as RunRow[];
    return rows
      .map(toRun)
      .filter((r) => (options.workspaceId === undefined || r.workspaceId === options.workspaceId) && (!options.states || options.states.includes(r.state)));
  }

  transitionRun(id: string, to: RunState, options: TransitionOptions = {}): Run {
    const opts = this.#parseTransitionOptions(options);
    return withTransaction(this.#db, () => {
      const current = this.#mustRun(id);
      this.#guard("run", current.state, to, RUN_TRANSITIONS[current.state], opts.expectedFrom);
      const ts = this.#ts();
      const terminal = RUN_TERMINAL_STATES.includes(to);
      this.#db
        .prepare(
          "UPDATE agent_runs SET state = ?, reason = ?, exit_code = COALESCE(?, exit_code), updated_at = ?, " +
            "started_at = CASE WHEN ? = 'RUNNING' AND started_at IS NULL THEN ? ELSE started_at END, " +
            "ended_at = CASE WHEN ? THEN ? ELSE ended_at END WHERE id = ? AND state = ?",
        )
        .run(to, opts.reason ?? null, opts.exitCode ?? null, ts, to, ts, terminal ? 1 : 0, ts, id, current.state);
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
   * Reconcile after a start. Policy (documented, deliberately small):
   *
   * - run RUNNING            -> BLOCKED / INTERRUPTED_BY_RESTART (the composer loop or the CLI supervision is gone);
   * - workspace CREATING     -> FAILED / INTERRUPTED_BY_RESTART (the worktree manager sweeps any stray Git worktree);
   * - workspace REMOVING     -> unchanged, reported for reconcile;
   * - run QUEUED/REVIEWING/BLOCKED -> unchanged (durable states a person or the scheduler acts on).
   *
   * One transaction: each change is written with its transition record and a
   * `journal.recovery` audit event, all or nothing. Running it again after a
   * crash (including a crash during recovery) is safe and converges.
   */
  recover(): RecoveryReport {
    return withTransaction(this.#db, () => {
      const ts = this.#ts();
      const runsInterrupted: string[] = [];
      const workspacesFailed: string[] = [];
      const workspacesNeedingReconcile: string[] = [];
      const runsLeftAlone: string[] = [];

      const stuckWorkspaces = this.#db
        .prepare("SELECT * FROM agent_workspaces WHERE state IN ('CREATING','REMOVING') ORDER BY created_at, id")
        .all() as unknown as WorkspaceRow[];
      for (const row of stuckWorkspaces) {
        if (row.state === "CREATING") {
          this.#db.prepare("UPDATE agent_workspaces SET state = 'FAILED', updated_at = ? WHERE id = ? AND state = 'CREATING'").run(ts, row.id);
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
          this.#audit.append({
            actor: "daemon",
            action: AuditActions.journalRecovery,
            target: `workspace:${row.id}`,
            outcome: "success",
            payload: { from: "REMOVING", to: "REMOVING", reason: "NEEDS_RECONCILE", projectId: row.project_id },
          });
          workspacesNeedingReconcile.push(row.id);
        }
      }

      const nonTerminalRuns = this.#db
        .prepare("SELECT * FROM agent_runs WHERE state IN ('QUEUED','RUNNING','REVIEWING','BLOCKED') ORDER BY created_at, id")
        .all() as unknown as RunRow[];
      for (const row of nonTerminalRuns) {
        if (row.state !== "RUNNING") {
          runsLeftAlone.push(row.id);
          continue;
        }
        this.#db
          .prepare("UPDATE agent_runs SET state = 'BLOCKED', reason = ?, updated_at = ? WHERE id = ? AND state = 'RUNNING'")
          .run(RESTART_REASON, ts, row.id);
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
      return { runsInterrupted, workspacesFailed, workspacesNeedingReconcile, runsLeftAlone };
    });
  }

  // ---- internals ----

  #ts(): string {
    return this.#now().toISOString();
  }

  #parseTransitionOptions(options: TransitionOptions): TransitionOptions {
    const parsed = transitionOptionsSchema.safeParse(options);
    if (!parsed.success) throw invalid(parsed.error, "transition options");
    return parsed.data as TransitionOptions;
  }

  #guard(
    entity: string,
    from: string,
    to: string,
    allowed: readonly string[],
    expectedFrom: string | undefined,
  ): void {
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

function hashBody(body: unknown): string {
  return createHash("sha256").update(canonicalize(body)).digest("hex");
}
