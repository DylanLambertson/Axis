// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash } from "node:crypto";
import { AxisError, canonicalize, isWellFormedString, type AuditActor } from "@axis/audit";
import { z } from "zod";
import { RUN_KINDS, RUN_STATES, WORKSPACE_STATES, type RunKind, type RunState, type WorkspaceState } from "./states.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const ACTOR = /^(?:user|daemon|agent:[A-Za-z0-9._-]{1,64})$/;
const noControl = (s: string): boolean => !/[\u0000-\u001f\u007f]/.test(s);
/** Printable, well-formed (lone surrogates would be rewritten by SQLite), bounded. */
const text = (max: number) => z.string().min(1).max(max).refine(noControl).refine(isWellFormedString);

const idempotencyKey = z.string().regex(UUID_V4);
const actorSchema = z.string().regex(ACTOR);

export const createWorkspaceSchema = z
  .object({
    projectId: text(128),
    branch: text(256),
    baseRef: text(256),
    baseSha: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
    createdBy: actorSchema,
    idempotencyKey: idempotencyKey.optional(),
  })
  .strict();

export const createRunSchema = z
  .object({
    workspaceId: text(128),
    kind: z.enum(RUN_KINDS),
    /** Required: the authenticated principal, never a default. */
    createdBy: actorSchema,
    idempotencyKey: idempotencyKey.optional(),
  })
  .strict();

const anyState = z.enum([...new Set([...WORKSPACE_STATES, ...RUN_STATES])] as [string, ...string[]]);

export const transitionOptionsSchema = z
  .object({
    reason: z.string().regex(REASON).optional(),
    actor: actorSchema.optional(),
    exitCode: z.number().int().min(-255).max(255).optional(),
    /** Optimistic guard: the transition applies only if the entity is in this state. */
    expectedFrom: anyState.optional(),
  })
  .strict();

export const runStateSchema = z.enum(RUN_STATES);
export const workspaceStateSchema = z.enum(WORKSPACE_STATES);
export const idSchema = text(128);

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
  /** The authenticated principal of the connection that asked, never a value taken from a request payload. */
  readonly createdBy: AuditActor;
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
   * Every workspace currently in REMOVING. Removal is idempotent against Git,
   * so the worktree manager finishes or rolls back from here. No state
   * change is made, and the audit event is written only the first time a
   * workspace is reported, so repeating `recover()` changes nothing.
   */
  readonly workspacesNeedingReconcile: readonly string[];
  /** Non-terminal runs recovery left alone (QUEUED, REVIEWING, BLOCKED): they are durable user-facing states. */
  readonly runsLeftAlone: readonly string[];
}

export interface WorkspaceRow {
  id: string;
  project_id: string;
  branch: string;
  base_ref: string;
  base_sha: string;
  created_by: string;
  state: string;
  reconcile_reported: number;
  created_at: string;
  updated_at: string;
}
export interface RunRow {
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

export const toWorkspace = (r: WorkspaceRow): Workspace => ({
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
export const toRun = (r: RunRow): Run => ({
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

export function invalid(error: z.ZodError, what: string): AxisError {
  // Only field paths: zod messages can echo the offending value.
  const fields = [...new Set(error.issues.map((i) => i.path.join(".") || "(root)"))].join(", ");
  return new AxisError("E_INVALID_ARGUMENT", `Invalid ${what}: ${fields}`);
}

export function hashBody(body: unknown): string {
  return createHash("sha256").update(canonicalize(body)).digest("hex");
}
