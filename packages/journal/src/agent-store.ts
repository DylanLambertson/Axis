// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError, withTransaction, type AuditLog, type DatabaseSync } from "@axis/audit";

/*
 * Agents and agent groups over schema version 12 (tickets PV-G1, PV-G3; ADR 0006 decisions 4 to 6 and 10;
 * docs/design/agents-contract.md). Every write is the user's, runs in the caller's transaction (the daemon wraps each
 * call in one), and writes one `journal.agent.record` audit event that names the ids and a fixed field, never a name
 * the user typed. A refusal is an `AxisError` whose `details.reason` is one of the contract's closed reasons.
 * The schema's triggers are the backstop for every rule here; these checks only name the refusal.
 */

export const AGENT_RECORD_ACTION = "journal.agent.record";
export const MAX_AGENTS = 500;
export const MAX_GROUPS = 100;

export type AgentLaunch =
  | { readonly kind: "composer"; readonly connection: string; readonly modelId: string; readonly mode: "ask" | "edit" | "agent" }
  | { readonly kind: "cli"; readonly entryId: string };

export interface AgentRecord {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly launch: AgentLaunch;
  readonly homeWorkspaceId: string;
  readonly groupId: string | null;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GroupRecord {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly order: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Changed<T> {
  readonly value: T;
  readonly changed: boolean;
}

type Row = Record<string, string | number | null>;

const refuse = (code: "E_NOT_FOUND" | "E_CONFLICT", reason: string): never => {
  throw new AxisError(code, "agent record refused", { reason });
};

function toAgent(r: Row): AgentRecord {
  const launch: AgentLaunch =
    r["kind"] === "cli"
      ? { kind: "cli", entryId: String(r["cli_entry_id"]) }
      : { kind: "composer", connection: String(r["connection"]), modelId: String(r["model_id"]), mode: r["default_mode"] as "ask" | "edit" | "agent" };
  return {
    id: String(r["id"]), projectId: String(r["project_id"]), name: String(r["name"]), launch, homeWorkspaceId: String(r["home_workspace_id"]),
    groupId: r["group_id"] === null ? null : String(r["group_id"]), archived: r["archived"] === 1, createdAt: String(r["created_at"]), updatedAt: String(r["updated_at"]),
  };
}
const toGroup = (r: Row): GroupRecord => ({
  id: String(r["id"]), projectId: String(r["project_id"]), name: String(r["name"]), order: Number(r["ord"]), createdAt: String(r["created_at"]), updatedAt: String(r["updated_at"]),
});
const launchColumns = (l: AgentLaunch): [string | null, string | null, string | null, string | null] =>
  l.kind === "cli" ? [l.entryId, null, null, null] : [null, l.connection, l.modelId, l.mode];
const sameLaunch = (a: AgentLaunch, b: AgentLaunch): boolean => JSON.stringify(launchColumns(a)) === JSON.stringify(launchColumns(b));

export class AgentRecords {
  readonly #db: DatabaseSync;
  readonly #audit: AuditLog;
  readonly #ts: () => string;

  constructor(db: DatabaseSync, audit: AuditLog, ts: () => string) {
    this.#db = db;
    this.#audit = audit;
    this.#ts = ts;
  }

  /** Runs `fn` in one transaction of the journal's database (a nested call joins the outer one). */
  transaction<T>(fn: () => T): T {
    return withTransaction(this.#db, fn);
  }

  #note(target: string, field: string, payload: Record<string, string>, actor: "user" | "daemon" | `agent:${string}` = "user"): void {
    this.#audit.append({ actor, action: AGENT_RECORD_ACTION, target, outcome: "success", payload: { field, ...payload } });
  }

  // ---- agents ----

  get(id: string): AgentRecord | undefined {
    const r = this.#db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined;
    return r === undefined ? undefined : toAgent(r);
  }

  list(projectId: string, includeArchived = false): AgentRecord[] {
    const sql = `SELECT * FROM agents WHERE project_id = ?${includeArchived ? "" : " AND archived = 0"} ORDER BY created_at, id LIMIT ${MAX_AGENTS}`;
    return (this.#db.prepare(sql).all(projectId) as Row[]).map(toAgent);
  }

  /** The agent with this live name (ASCII case folded, as the index), or undefined. */
  #liveNamed(projectId: string, name: string): string | undefined {
    const r = this.#db.prepare("SELECT id FROM agents WHERE project_id = ? AND archived = 0 AND name = ? COLLATE NOCASE").get(projectId, name) as Row | undefined;
    return r === undefined ? undefined : String(r["id"]);
  }

  #group(projectId: string, groupId: string | null): void {
    if (groupId === null) return;
    const g = this.getGroup(groupId);
    if (g === undefined) refuse("E_NOT_FOUND", "not_found");
    if (g!.projectId !== projectId) refuse("E_CONFLICT", "cross_project");
  }

  create(input: { readonly id: string; readonly projectId: string; readonly name: string; readonly launch: AgentLaunch; readonly homeWorkspaceId: string; readonly groupId: string | null }): AgentRecord {
    const count = this.#db.prepare("SELECT count(*) AS n FROM agents WHERE project_id = ?").get(input.projectId) as { n: number };
    if (count.n >= MAX_AGENTS) refuse("E_CONFLICT", "limit_reached");
    const home = this.#db.prepare("SELECT project_id, state FROM agent_workspaces WHERE id = ?").get(input.homeWorkspaceId) as Row | undefined;
    if (home === undefined) refuse("E_NOT_FOUND", "not_found");
    if (home!["project_id"] !== input.projectId) refuse("E_CONFLICT", "cross_project");
    if (home!["state"] !== "READY") refuse("E_CONFLICT", "home_unavailable");
    this.#group(input.projectId, input.groupId);
    if (this.#liveNamed(input.projectId, input.name) !== undefined) refuse("E_CONFLICT", "name_taken");
    const ts = this.#ts();
    this.#db
      .prepare(
        "INSERT INTO agents (id, project_id, name, kind, cli_entry_id, connection, model_id, default_mode, home_workspace_id, group_id, created_by, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?)",
      )
      .run(input.id, input.projectId, input.name, input.launch.kind, ...launchColumns(input.launch), input.homeWorkspaceId, input.groupId, ts, ts);
    this.#note(`agent:${input.id}`, "create", { agentId: input.id, projectId: input.projectId, workspaceId: input.homeWorkspaceId, kind: input.launch.kind, ...(input.groupId === null ? {} : { groupId: input.groupId }) });
    return this.get(input.id)!;
  }

  #live(id: string): AgentRecord {
    const a = this.get(id);
    if (a === undefined) return refuse("E_NOT_FOUND", "not_found");
    if (a.archived) refuse("E_CONFLICT", "archived");
    return a;
  }

  #set(id: string, sql: string, args: Array<string | number | null>, field: string, payload: Record<string, string> = {}): AgentRecord {
    this.#db.prepare(`UPDATE agents SET ${sql}, updated_at = ? WHERE id = ?`).run(...args, this.#ts(), id);
    this.#note(`agent:${id}`, field, { agentId: id, ...payload });
    return this.get(id)!;
  }

  rename(id: string, name: string): Changed<AgentRecord> {
    const a = this.#live(id);
    if (a.name === name) return { value: a, changed: false };
    const holder = this.#liveNamed(a.projectId, name);
    if (holder !== undefined && holder !== id) refuse("E_CONFLICT", "name_taken");
    return { value: this.#set(id, "name = ?", [name], "rename"), changed: true };
  }

  setLaunch(id: string, launch: AgentLaunch): Changed<AgentRecord> {
    const a = this.#live(id);
    if (a.launch.kind !== launch.kind) refuse("E_CONFLICT", "kind_changed");
    if (sameLaunch(a.launch, launch)) return { value: a, changed: false };
    return { value: this.#set(id, "cli_entry_id = ?, connection = ?, model_id = ?, default_mode = ?", launchColumns(launch), "launch"), changed: true };
  }

  archive(id: string): Changed<AgentRecord> {
    const a = this.get(id);
    if (a === undefined) return refuse("E_NOT_FOUND", "not_found");
    if (a.archived) return { value: a, changed: false };
    const ts = this.#ts();
    return { value: this.#set(id, "archived = 1, archived_at = ?", [ts], "archive", { reason: "user" }), changed: true };
  }

  restore(id: string): Changed<AgentRecord> {
    const a = this.get(id);
    if (a === undefined) return refuse("E_NOT_FOUND", "not_found");
    if (!a.archived) return { value: a, changed: false };
    const home = this.#db.prepare("SELECT state FROM agent_workspaces WHERE id = ?").get(a.homeWorkspaceId) as Row | undefined;
    if (home?.["state"] !== "READY" && home?.["state"] !== "CREATING") refuse("E_CONFLICT", "home_unavailable");
    if (this.#liveNamed(a.projectId, a.name) !== undefined) refuse("E_CONFLICT", "name_taken");
    return { value: this.#set(id, "archived = 0, archived_at = NULL", [], "restore"), changed: true };
  }

  assign(id: string, groupId: string | null): Changed<AgentRecord> {
    const a = this.#live(id);
    this.#group(a.projectId, groupId);
    if (a.groupId === groupId) return { value: a, changed: false };
    return { value: this.#set(id, "group_id = ?", [groupId], "assign", groupId === null ? {} : { groupId }), changed: true };
  }

  /** The live agents a workspace is home to: what the version 12 trigger archives when it leaves CREATING or READY. */
  liveOn(workspaceId: string): string[] {
    return (this.#db.prepare("SELECT id FROM agents WHERE home_workspace_id = ? AND archived = 0 ORDER BY id").all(workspaceId) as Row[]).map((r) => String(r["id"]));
  }

  /** Audits the archives the trigger made in the transition that just ran (one event per agent, by the transition's actor). */
  noteArchivedWithHome(ids: readonly string[], workspaceId: string, actor: "user" | "daemon" | `agent:${string}`): void {
    // The trigger archived every id `liveOn` returned in the same statement that moved the workspace.
    for (const id of ids) {
      this.#note(`agent:${id}`, "archive", { agentId: id, workspaceId, reason: "home_not_live" }, actor);
    }
  }

  /** The agent a run was started for (`agent_runs.agent_id`, fixed at insert), or undefined for a run of no agent. */
  agentOfRun(runId: string): string | undefined {
    const r = this.#db.prepare("SELECT agent_id FROM agent_runs WHERE id = ?").get(runId) as Row | undefined;
    return r === undefined || r["agent_id"] === null ? undefined : String(r["agent_id"]);
  }

  /** A project's live agents as messaging needs them (id, group, kind), in id order, at most `limit`: the cap is the query's. */
  liveEntries(projectId: string, limit: number): Array<{ readonly id: string; readonly groupId: string | null; readonly kind: "composer" | "cli" }> {
    return (this.#db.prepare("SELECT id, group_id, kind FROM agents WHERE project_id = ? AND archived = 0 ORDER BY id LIMIT ?").all(projectId, limit) as Row[]).map((r) => ({
      id: String(r["id"]),
      groupId: r["group_id"] === null ? null : String(r["group_id"]),
      kind: r["kind"] as "composer" | "cli",
    }));
  }

  /** The live agents in a group, in id order, at most `limit`. */
  liveMembers(groupId: string, limit: number): string[] {
    return (this.#db.prepare("SELECT id FROM agents WHERE group_id = ? AND archived = 0 ORDER BY id LIMIT ?").all(groupId, limit) as Row[]).map((r) => String(r["id"]));
  }

  // ---- groups ----

  getGroup(id: string): GroupRecord | undefined {
    const r = this.#db.prepare("SELECT * FROM agent_groups WHERE id = ?").get(id) as Row | undefined;
    return r === undefined ? undefined : toGroup(r);
  }

  listGroups(projectId: string): GroupRecord[] {
    return (this.#db.prepare(`SELECT * FROM agent_groups WHERE project_id = ? ORDER BY ord, id LIMIT ${MAX_GROUPS}`).all(projectId) as Row[]).map(toGroup);
  }

  createGroup(input: { readonly id: string; readonly projectId: string; readonly name: string }): GroupRecord {
    const r = this.#db.prepare("SELECT count(*) AS n, coalesce(max(ord), -1) AS top FROM agent_groups WHERE project_id = ?").get(input.projectId) as { n: number; top: number };
    if (r.n >= MAX_GROUPS || r.top >= 9999) refuse("E_CONFLICT", "limit_reached");
    const ts = this.#ts();
    this.#db.prepare("INSERT INTO agent_groups (id, project_id, name, ord, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'user', ?, ?)").run(input.id, input.projectId, input.name, r.top + 1, ts, ts);
    this.#note(`group:${input.id}`, "group.create", { groupId: input.id, projectId: input.projectId });
    return this.getGroup(input.id)!;
  }

  renameGroup(id: string, name: string): Changed<GroupRecord> {
    const g = this.getGroup(id);
    if (g === undefined) return refuse("E_NOT_FOUND", "not_found");
    if (g.name === name) return { value: g, changed: false };
    this.#db.prepare("UPDATE agent_groups SET name = ?, updated_at = ? WHERE id = ?").run(name, this.#ts(), id);
    this.#note(`group:${id}`, "group.rename", { groupId: id });
    return { value: this.getGroup(id)!, changed: true };
  }

  /** The full new order: exactly the project's group ids, each once (`order_mismatch` otherwise). */
  reorderGroups(projectId: string, ids: readonly string[]): GroupRecord[] {
    const current = this.listGroups(projectId).map((g) => g.id);
    if (current.length !== ids.length || new Set(ids).size !== ids.length || !ids.every((id) => current.includes(id))) refuse("E_CONFLICT", "order_mismatch");
    const ts = this.#ts();
    ids.forEach((id, ord) => this.#db.prepare("UPDATE agent_groups SET ord = ?, updated_at = ? WHERE id = ? AND ord <> ?").run(ord, ts, id, ord));
    this.#note(`project:${projectId}`, "group.reorder", { projectId });
    return this.listGroups(projectId);
  }

  /** Deletes the group; its agents (archived ones too) are ungrouped by the schema's trigger. Returns their ids. */
  deleteGroup(id: string): string[] {
    const g = this.getGroup(id);
    if (g === undefined) return refuse("E_NOT_FOUND", "not_found");
    const members = (this.#db.prepare("SELECT id FROM agents WHERE group_id = ? ORDER BY id").all(id) as Row[]).map((r) => String(r["id"]));
    this.#db.prepare("DELETE FROM agent_groups WHERE id = ?").run(id);
    this.#note(`group:${id}`, "group.delete", { groupId: id, projectId: g.projectId, count: String(members.length) });
    return members;
  }
}
