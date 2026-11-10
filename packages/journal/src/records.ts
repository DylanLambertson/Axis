// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { dirname, isAbsolute, normalize } from "node:path";
import { AxisError, isWellFormedString, type AuditActor, type AuditLog, type DatabaseSync } from "@axis/audit";
import { z } from "zod";
import { RUN_STATES, RUN_TERMINAL_STATES } from "./states.js";
import { UserPrincipal } from "./principal.js";
import { invalid, toProject, toWorkspace, type Project, type ProjectRow, type Workspace, type WorkspaceRow } from "./model.js";

const noControl = (s: string): boolean => !/[\u0000-\u001f\u007f]/.test(s);
const ACTOR = /^(?:user|daemon|agent:[A-Za-z0-9._-]{1,64})$/;
const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Absolute, already normalised, printable, bounded. Whether it is a real directory is the host's check (realpath at use). */
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(noControl)
  .refine(isWellFormedString)
  .refine((p) => isAbsolute(p), { message: "absolute" })
  // `/repo/` and `/repo` are one directory: store the one without the trailing separator. A root is never a project or worktree.
  .transform((p) => (p.length > 1 ? p.replace(/[\\/]+$/, "") || p.slice(0, 1) : p))
  .refine((p) => normalize(p) === p && dirname(p) !== p, { message: "normalised and not a root" });

export const registerProjectSchema = z
  .object({
    id: z.string().min(1).max(128).refine(noControl).refine(isWellFormedString),
    path: absolutePath,
    displayName: z.string().min(1).max(256).refine(noControl).refine(isWellFormedString),
    trusted: z.boolean(),
    actor: z.string().regex(ACTOR),
  })
  .strict();
export type RegisterProjectInput = Omit<z.infer<typeof registerProjectSchema>, "actor"> & { readonly actor: AuditActor };

const workspaceId = z.string().min(1).max(128).refine(noControl).refine(isWellFormedString);
const actorOnly = z.string().regex(ACTOR);
export const worktreePathSchema = absolutePath;
export const baseBranchSchema = z.string().min(12).max(300).regex(/^refs\/heads\/[!-~]+$/).refine((r) => !r.includes(".."));
export const baseTipSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
export const hashSchema = z.string().regex(HASH);
export const workspaceIdSchema = workspaceId;
export const actorSchema = actorOnly;

export interface RecordsContext {
  readonly db: DatabaseSync;
  readonly audit: AuditLog;
  readonly ts: () => string;
}

/** SQLITE_CONSTRAINT_UNIQUE (2067) or _PRIMARYKEY (1555); a CHECK or NOT NULL failure is something else. */
const isUnique = (error: unknown): boolean => [1555, 2067].includes((error as { errcode?: number } | null)?.errcode ?? 0);

/**
 * Journal-first audit for the host's records. The action has no payload allow-list entry, so only a
 * content summary is stored: the event names what changed (`target`, `field`), never the value.
 */
function audit(ctx: RecordsContext, actor: AuditActor, action: string, target: string, field: string): void {
  ctx.audit.append({ actor, action, target, outcome: "success", payload: { field } });
}

export function registerProject(ctx: RecordsContext, input: RegisterProjectInput): Project {
  const parsed = registerProjectSchema.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error, "project");
  const p = parsed.data;
  const ts = ctx.ts();
  try {
    ctx.db
      .prepare("INSERT INTO projects (id, path, display_name, trusted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(p.id, p.path, p.displayName, p.trusted ? 1 : 0, ts, ts);
  } catch (error) {
    if (isUnique(error)) throw new AxisError("E_CONFLICT", "A project with that id or path is already registered");
    throw error;
  }
  audit(ctx, input.actor, "journal.project.register", `project:${p.id}`, "project");
  return mustProject(ctx.db, p.id);
}

export function getProject(db: DatabaseSync, id: string): Project | undefined {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  return row ? toProject(row) : undefined;
}

export function listProjects(db: DatabaseSync): Project[] {
  return (db.prepare("SELECT * FROM projects ORDER BY created_at, id").all() as unknown as ProjectRow[]).map(toProject);
}

function mustProject(db: DatabaseSync, id: string): Project {
  const p = getProject(db, id);
  if (!p) throw new AxisError("E_NOT_FOUND", "Project not found");
  return p;
}

function load(db: DatabaseSync, id: unknown): WorkspaceRow {
  const parsed = workspaceId.safeParse(id);
  if (!parsed.success) throw invalid(parsed.error, "workspace id");
  const row = db.prepare("SELECT * FROM agent_workspaces WHERE id = ?").get(parsed.data) as WorkspaceRow | undefined;
  if (!row) throw new AxisError("E_NOT_FOUND", "Workspace not found");
  return row;
}

function parseActor(actor: unknown): AuditActor {
  const parsed = actorOnly.safeParse(actor);
  if (!parsed.success) throw invalid(parsed.error, "actor");
  return parsed.data as AuditActor;
}

function update(ctx: RecordsContext, sql: string, args: Array<string | null>, id: string): Workspace {
  const result = ctx.db.prepare(`UPDATE agent_workspaces SET ${sql}, updated_at = ? WHERE id = ?`).run(...args, ctx.ts(), id);
  if (Number(result.changes) !== 1) throw new AxisError("E_INTERNAL", "A workspace record update did not apply to exactly one row");
  return toWorkspace(load(ctx.db, id));
}

/** Set once, while the workspace is being created or ready. The same value again is a no-op; a different one is refused. */
export function setWorktreePath(ctx: RecordsContext, id: string, path: string, actor: AuditActor): Workspace {
  const a = parseActor(actor);
  const parsed = worktreePathSchema.safeParse(path);
  if (!parsed.success) throw invalid(parsed.error, "worktree path");
  const row = load(ctx.db, id);
  if (row.state !== "CREATING" && row.state !== "READY") {
    throw new AxisError("E_CONFLICT", "A worktree path can only be recorded for a workspace being created or ready", { state: row.state });
  }
  if (row.worktree_path === parsed.data) return toWorkspace(row);
  if (row.worktree_path !== null) throw new AxisError("E_CONFLICT", "The worktree path is already recorded and does not change");
  let out: Workspace;
  try {
    out = update(ctx, "worktree_path = ?", [parsed.data], row.id);
  } catch (error) {
    if (isUnique(error)) throw new AxisError("E_CONFLICT", "Another live workspace already uses that worktree path");
    throw error;
  }
  audit(ctx, a, "journal.workspace.record", `workspace:${row.id}`, "worktreePath");
  return out;
}

/**
 * The base branch the daemon resolved at create and the commit it pointed at then (FU-WT-BASE2): both at once, once, only
 * while CREATING, a printable `refs/heads/` name and a full commit sha. Recording the same pair again is a no-op.
 */
export function recordBaseBranch(ctx: RecordsContext, id: string, ref: string, tip: string, actor: AuditActor): Workspace {
  const a = parseActor(actor);
  const parsed = baseBranchSchema.safeParse(ref);
  if (!parsed.success) throw invalid(parsed.error, "base branch");
  const tipParsed = baseTipSchema.safeParse(tip);
  if (!tipParsed.success) throw invalid(tipParsed.error, "base tip");
  const row = load(ctx.db, id);
  if (row.base_branch === parsed.data && row.base_tip === tipParsed.data) return toWorkspace(row);
  if (row.state !== "CREATING") throw new AxisError("E_CONFLICT", "A base branch can only be recorded while the workspace is being created", { state: row.state });
  if (row.base_branch !== null || row.base_tip !== null) throw new AxisError("E_CONFLICT", "The base branch is already recorded and does not change");
  const out = update(ctx, "base_branch = ?, base_tip = ?", [parsed.data, tipParsed.data], row.id);
  audit(ctx, a, "journal.workspace.record", `workspace:${row.id}`, "baseBranch");
  return out;
}

export function lockWorkspace(ctx: RecordsContext, id: string, actor: AuditActor): Workspace {
  const a = parseActor(actor);
  const row = load(ctx.db, id);
  if (row.state === "REMOVED" || row.state === "FAILED") {
    throw new AxisError("E_CONFLICT", "A workspace that is gone cannot be locked", { state: row.state });
  }
  if (row.lock_state === "locked") throw new AxisError("E_CONFLICT", "The workspace is already locked");
  const out = update(ctx, "lock_state = 'locked', locked_at = ?", [ctx.ts()], row.id);
  audit(ctx, a, "journal.workspace.lock", `workspace:${row.id}`, "lock");
  return out;
}

export function unlockWorkspace(ctx: RecordsContext, id: string, actor: AuditActor): Workspace {
  const a = parseActor(actor);
  const row = load(ctx.db, id);
  if (row.lock_state === "unlocked") return toWorkspace(row);
  const out = update(ctx, "lock_state = 'unlocked', locked_at = NULL", [], row.id);
  audit(ctx, a, "journal.workspace.unlock", `workspace:${row.id}`, "lock");
  return out;
}

export function recordPushed(ctx: RecordsContext, id: string, sha: string, actor: AuditActor): Workspace {
  const a = parseActor(actor);
  const parsed = hashSchema.safeParse(sha);
  if (!parsed.success) throw invalid(parsed.error, "pushed sha");
  const row = load(ctx.db, id);
  if (row.state !== "READY" && row.state !== "FINALISED") {
    throw new AxisError("E_CONFLICT", "A push can only be recorded for a ready or finalised workspace", { state: row.state });
  }
  const out = update(ctx, "last_pushed_sha = ?", [parsed.data], row.id);
  audit(ctx, a, "journal.workspace.record", `workspace:${row.id}`, "lastPushedSha");
  return out;
}

/** Recording the reviewed tree is the person's act (REV-1: the commit is built from it), so it takes the minted principal, as run approval does. */
export function recordReviewedTree(ctx: RecordsContext, id: string, treeHash: string, principal: UserPrincipal): Workspace {
  if (!UserPrincipal.is(principal)) {
    throw new AxisError("E_POLICY_DENIED", "Only the user, acting through the daemon, can record a reviewed tree");
  }
  const a: AuditActor = "user";
  const parsed = hashSchema.safeParse(treeHash);
  if (!parsed.success) throw invalid(parsed.error, "reviewed tree hash");
  const row = load(ctx.db, id);
  if (row.state !== "READY") {
    throw new AxisError("E_CONFLICT", "A review can only be recorded for a ready workspace", { state: row.state });
  }
  const out = update(ctx, "reviewed_tree_hash = ?, reviewed_at = ?", [parsed.data, ctx.ts()], row.id);
  audit(ctx, a, "journal.workspace.record", `workspace:${row.id}`, "reviewedTreeHash");
  return out;
}

const OPEN = `(${RUN_STATES.filter((s) => !RUN_TERMINAL_STATES.includes(s))
  .map((s) => `'${s}'`)
  .join(",")})`;

/** Rules a workspace transition has beyond the state table: runs finished, outcome only for FINALISED, REMOVING falls back to where it came from. */
export function checkWorkspaceTransition(db: DatabaseSync, id: string, from: string, to: string, outcome: string | undefined): void {
  // Finalising needs an outcome; a removal falling back to FINALISED keeps the one it had.
  if ((to === "FINALISED" && from !== "REMOVING") !== (outcome !== undefined)) {
    throw new AxisError("E_INVALID_ARGUMENT", "An outcome is required to finalise a workspace and is refused for any other change");
  }
  if (to === "REMOVING" || to === "FINALISED") {
    const open = db.prepare(`SELECT COUNT(*) AS n FROM agent_runs WHERE workspace_id = ? AND state IN ${OPEN}`).get(id) as { n: number };
    if (open.n > 0) throw new AxisError("E_CONFLICT", "The workspace still has runs that are not finished", { openRuns: open.n });
  }
  if (from === "REMOVING" && (to === "READY" || to === "FINALISED")) {
    const last = db
      .prepare("SELECT from_state FROM state_transitions WHERE entity = 'workspace' AND entity_id = ? AND to_state = 'REMOVING' ORDER BY id DESC LIMIT 1")
      .get(id) as { from_state: string | null } | undefined;
    if (last?.from_state !== to) {
      throw new AxisError("E_CONFLICT", "A removal falls back only to the state it started from", { to, startedFrom: last?.from_state ?? null });
    }
  }
}

/** Recovery: a lock recorded by a process that is gone guards nothing. Clears each and audits it once. Returns the ids. */
export function clearStaleLocks(ctx: RecordsContext): string[] {
  const rows = ctx.db.prepare("SELECT id, project_id FROM agent_workspaces WHERE lock_state = 'locked' ORDER BY created_at, id").all() as unknown as Array<{ id: string; project_id: string }>;
  for (const row of rows) {
    const r = ctx.db.prepare("UPDATE agent_workspaces SET lock_state = 'unlocked', locked_at = NULL, updated_at = ? WHERE id = ? AND lock_state = 'locked'").run(ctx.ts(), row.id);
    if (Number(r.changes) !== 1) throw new AxisError("E_INTERNAL", "A lock update did not apply to exactly one row");
    ctx.audit.append({
      actor: "daemon",
      action: "journal.recovery",
      target: `workspace:${row.id}`,
      outcome: "success",
      payload: { from: "locked", to: "unlocked", reason: "STALE_LOCK", projectId: row.project_id },
    });
  }
  return rows.map((r) => r.id);
}
