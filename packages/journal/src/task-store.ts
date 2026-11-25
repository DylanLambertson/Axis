// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError, withTransaction, type DatabaseSync } from "@axis/audit";
import { TASK_LIMITS, projectTaskBytesSql } from "./schema-tasks.js";

/**
 * Tasks, their revisions and links (schema version 15, ticket PV-T1 slice 1, `docs/design/tasks-store.md`). A data layer:
 * the daemon's tasks service (slice 2) decides who may call what and writes the audit; Start, which shows the full prompt
 * and taints the run (IAC-T source 5), is slice 2's. The store derives the task's trust itself and the table checks it.
 */
export type TaskSource = "user" | "agent" | "plugin" | "integration";
export type TaskStatus = "open" | "in_progress" | "blocked" | "done" | "cancelled";
export type TaskAuthor =
  | { readonly kind: "user" }
  | { readonly kind: "system"; readonly hop: number }
  | { readonly kind: "agent"; readonly agentId: string; readonly hop: number }
  | { readonly kind: "plugin"; readonly pluginId: string; readonly hop: number }
  | { readonly kind: "integration"; readonly integrationId: string; readonly hop: number };
export type TaskAssignee = { readonly kind: "agent"; readonly id: string } | { readonly kind: "group"; readonly id: string };
export type TaskLink = { readonly kind: "run" | "workspace" | "page" | "pr"; readonly target: string };

export interface TaskRecord {
  readonly taskId: string;
  readonly projectId: string;
  readonly source: TaskSource;
  readonly status: TaskStatus;
  readonly assignee: TaskAssignee | null;
  /** The text may hold text the user did not write: a task read taints (source 8), Start taints (source 5). Sticky. */
  readonly untrusted: boolean;
  readonly hop: number;
  readonly lastSeq: number;
  readonly links: readonly TaskLink[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface TaskRevisionRecord {
  readonly taskId: string;
  readonly seq: number;
  readonly title: string;
  readonly body: string;
  readonly author: TaskAuthor;
  readonly hop: number;
  readonly createdAt: string;
}
export type TaskRevisionMeta = Omit<TaskRevisionRecord, "body">;

type Row = Record<string, unknown>;
const refuse = (code: "E_NOT_FOUND" | "E_CONFLICT" | "E_INVALID_ARGUMENT", reason: string, message: string): never => {
  throw new AxisError(code, message, { reason });
};
const NOT_FOUND = (): never => refuse("E_NOT_FOUND", "not_found", "The task does not exist");
const SOURCES: ReadonlySet<string> = new Set(["user", "agent", "plugin", "integration"]);
const STATUSES: ReadonlySet<string> = new Set(["open", "in_progress", "blocked", "done", "cancelled"]);
const LINK_KINDS: ReadonlySet<string> = new Set(["run", "workspace", "page", "pr"]);
const REVISION_COLUMNS = "task_id, seq, title, author_kind, author_id, hop, created_at";

function authorOf(r: Row): TaskAuthor {
  const hop = Number(r["hop"]);
  const authorId = String(r["author_id"]);
  switch (r["author_kind"]) {
    case "user": return { kind: "user" };
    case "system": return { kind: "system", hop };
    case "agent": return { kind: "agent", agentId: authorId, hop };
    case "plugin": return { kind: "plugin", pluginId: authorId, hop };
    case "integration": return { kind: "integration", integrationId: authorId, hop };
    default: throw new AxisError("E_INTERNAL", "A stored task revision has no known author");
  }
}
const metaOf = (r: Row): TaskRevisionMeta => ({ taskId: String(r["task_id"]), seq: Number(r["seq"]), title: String(r["title"]), author: authorOf(r), hop: Number(r["hop"]), createdAt: String(r["created_at"]) });
function authorIdOf(a: TaskAuthor): string | null {
  return a.kind === "agent" ? a.agentId : a.kind === "plugin" ? a.pluginId : a.kind === "integration" ? a.integrationId : null;
}
function checkAuthor(a: TaskAuthor): void {
  const ok = a !== null && typeof a === "object" && (a.kind === "user" ||
    (["system", "agent", "plugin", "integration"].includes(a.kind) && Number.isSafeInteger(a.hop) && a.hop >= 0 && a.hop <= 8 && (a.kind === "system" || typeof authorIdOf(a) === "string")));
  if (!ok) refuse("E_INVALID_ARGUMENT", "author", "A task revision needs a known author");
}
function checkText(title: string, body: string): void {
  if (typeof title !== "string" || typeof body !== "string") refuse("E_INVALID_ARGUMENT", "text", "A task revision needs a title and a body");
  if (title.length > TASK_LIMITS.titleChars || body.length > TASK_LIMITS.bodyChars) refuse("E_INVALID_ARGUMENT", "too_large", "The task is over its size limit");
}
const bytesOf = (s: string): number => Buffer.byteLength(s, "utf8");

export class TaskRecords {
  readonly #db: DatabaseSync;
  readonly #ts: () => string;

  constructor(db: DatabaseSync, ts: () => string) {
    this.#db = db;
    this.#ts = ts;
  }

  /** Runs `fn` in one transaction of the journal's database (a write with its audit row; a nested call joins the outer one). */
  transaction<T>(fn: () => T): T {
    return withTransaction(this.#db, fn);
  }

  /** The project a task belongs to, or undefined. */
  projectOf(taskId: string): string | undefined {
    const r = this.#db.prepare("SELECT project_id FROM tasks WHERE id = ?").get(taskId) as Row | undefined;
    return r === undefined ? undefined : String(r["project_id"]);
  }

  /** A new task and its first revision, written by its source. `taskId` comes from the caller (the daemon's random id). */
  create(input: { readonly taskId: string; readonly projectId: string; readonly title: string; readonly body: string; readonly author: Exclude<TaskAuthor, { kind: "system" }> }): TaskRecord {
    checkAuthor(input.author);
    checkText(input.title, input.body);
    if (!SOURCES.has(input.author.kind)) refuse("E_INVALID_ARGUMENT", "author", "A task's source is the user, an agent, a plugin or an integration");
    return withTransaction(this.#db, () => {
      if (this.#db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(input.taskId) !== undefined) refuse("E_CONFLICT", "exists", "A task with that id exists");
      const n = Number((this.#db.prepare("SELECT count(*) AS n FROM tasks WHERE project_id = ?").get(input.projectId) as Row)["n"]);
      if (n >= TASK_LIMITS.tasksPerProject) refuse("E_CONFLICT", "limit_reached", "The project holds its maximum of tasks");
      this.#checkBytes(input.projectId, bytesOf(input.title) + bytesOf(input.body));
      const at = this.#ts();
      this.#db
        .prepare("INSERT INTO tasks (id, project_id, source, status, untrusted, hop, last_seq, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, 0, 0, ?, ?)")
        .run(input.taskId, input.projectId, input.author.kind, input.author.kind === "user" ? 0 : 1, at, at);
      this.#insert(input.taskId, 1, input.title, input.body, input.author, at);
      return this.get(input.taskId) as TaskRecord;
    });
  }

  /** A new revision on top of `baseSeq`; refused (`stale_version`) when another came first. */
  update(input: { readonly taskId: string; readonly baseSeq: number; readonly title: string; readonly body: string; readonly author: TaskAuthor }): TaskRecord {
    checkAuthor(input.author);
    checkText(input.title, input.body);
    return withTransaction(this.#db, () => {
      const t = this.#task(input.taskId);
      if (t.lastSeq !== input.baseSeq) refuse("E_CONFLICT", "stale_version", "The task changed since that revision");
      this.#checkBytes(t.projectId, bytesOf(input.title) + bytesOf(input.body));
      this.#insert(input.taskId, t.lastSeq + 1, input.title, input.body, input.author, this.#ts());
      return this.get(input.taskId) as TaskRecord;
    });
  }

  setStatus(taskId: string, status: TaskStatus): TaskRecord {
    if (!STATUSES.has(status)) refuse("E_INVALID_ARGUMENT", "status", "Unknown task status");
    return withTransaction(this.#db, () => {
      this.#task(taskId);
      this.#db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, this.#ts(), taskId);
      return this.get(taskId) as TaskRecord;
    });
  }

  /** Assign to a live agent or a group of the task's project, or clear (`null`); refused `assignee_refused` otherwise. */
  assign(taskId: string, assignee: TaskAssignee | null): TaskRecord {
    if (assignee !== null && (typeof assignee !== "object" || (assignee.kind !== "agent" && assignee.kind !== "group") || typeof assignee.id !== "string")) {
      refuse("E_INVALID_ARGUMENT", "assignee", "An assignee is an agent or a group");
    }
    return withTransaction(this.#db, () => {
      const t = this.#task(taskId);
      if (assignee !== null) {
        const table = assignee.kind === "agent" ? "agents WHERE id = ? AND project_id = ? AND archived = 0" : "agent_groups WHERE id = ? AND project_id = ?";
        if (this.#db.prepare(`SELECT 1 FROM ${table}`).get(assignee.id, t.projectId) === undefined) refuse("E_CONFLICT", "assignee_refused", "No such assignee in the project");
      }
      this.#db.prepare("UPDATE tasks SET assignee_kind = ?, assignee_id = ?, updated_at = ? WHERE id = ?").run(assignee?.kind ?? null, assignee?.id ?? null, this.#ts(), taskId);
      return this.get(taskId) as TaskRecord;
    });
  }

  /** Link a run, workspace or page of the task's project, or a pull request number; false when the link exists. */
  link(taskId: string, link: TaskLink): boolean {
    if (typeof link !== "object" || link === null || !LINK_KINDS.has(link.kind) || typeof link.target !== "string") refuse("E_INVALID_ARGUMENT", "link", "Unknown link");
    if (link.kind === "pr" && !/^[1-9][0-9]{0,9}$/.test(link.target)) refuse("E_INVALID_ARGUMENT", "link", "A pull request link is its number");
    return withTransaction(this.#db, () => {
      this.#task(taskId);
      if (this.#db.prepare("SELECT 1 FROM task_links WHERE task_id = ? AND kind = ? AND target = ?").get(taskId, link.kind, link.target) !== undefined) return false;
      const n = Number((this.#db.prepare("SELECT count(*) AS n FROM task_links WHERE task_id = ?").get(taskId) as Row)["n"]);
      if (n >= TASK_LIMITS.linksPerTask) refuse("E_CONFLICT", "limit_reached", "The task holds its maximum of links");
      try {
        this.#db.prepare("INSERT INTO task_links (task_id, kind, target, created_at) VALUES (?, ?, ?, ?)").run(taskId, link.kind, link.target, this.#ts());
      } catch {
        refuse("E_CONFLICT", "link_refused", "The link names nothing of the task's project");
      }
      return true;
    });
  }

  /** Remove a link; false when it did not exist. */
  unlink(taskId: string, link: TaskLink): boolean {
    return Number(this.#db.prepare("DELETE FROM task_links WHERE task_id = ? AND kind = ? AND target = ?").run(taskId, link.kind, link.target).changes) === 1;
  }

  /** Delete a task with its revisions and links. */
  delete(taskId: string): void {
    withTransaction(this.#db, () => {
      this.#task(taskId);
      this.#db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
    });
  }

  get(taskId: string): TaskRecord | undefined {
    const r = this.#db.prepare("SELECT id, project_id, source, status, assignee_kind, assignee_id, untrusted, hop, last_seq, created_at, updated_at FROM tasks WHERE id = ?").get(taskId) as Row | undefined;
    if (r === undefined) return undefined;
    const links = (this.#db.prepare("SELECT kind, target FROM task_links WHERE task_id = ? ORDER BY created_at, kind, target").all(taskId) as Row[]).map((l) => ({ kind: l["kind"] as TaskLink["kind"], target: String(l["target"]) }));
    return {
      taskId: String(r["id"]),
      projectId: String(r["project_id"]),
      source: r["source"] as TaskSource,
      status: r["status"] as TaskStatus,
      assignee: r["assignee_kind"] === null ? null : { kind: r["assignee_kind"] as TaskAssignee["kind"], id: String(r["assignee_id"]) },
      untrusted: r["untrusted"] === 1,
      hop: Number(r["hop"]),
      lastSeq: Number(r["last_seq"]),
      links,
      createdAt: String(r["created_at"]),
      updatedAt: String(r["updated_at"]),
    };
  }

  /** A revision with its body (the newest when `seq` is omitted). */
  revision(taskId: string, seq?: number): TaskRevisionRecord | undefined {
    const r = (seq === undefined
      ? this.#db.prepare(`SELECT body, ${REVISION_COLUMNS.split(", ").map((c) => `r.${c}`).join(", ")} FROM task_revisions r JOIN tasks t ON t.id = r.task_id AND r.seq = t.last_seq WHERE t.id = ?`).get(taskId)
      : this.#db.prepare(`SELECT body, ${REVISION_COLUMNS} FROM task_revisions WHERE task_id = ? AND seq = ?`).get(taskId, seq)) as Row | undefined;
    return r === undefined ? undefined : { ...metaOf(r), body: String(r["body"]) };
  }

  /** The task's revisions, newest first, without bodies (at most 50). */
  revisions(taskId: string): TaskRevisionMeta[] {
    this.#task(taskId);
    return (this.#db.prepare(`SELECT ${REVISION_COLUMNS} FROM task_revisions WHERE task_id = ? ORDER BY seq DESC`).all(taskId) as Row[]).map(metaOf);
  }

  /** A project's tasks, most recently changed first (at most 1,000), optionally of one status. */
  list(projectId: string, status?: TaskStatus): TaskRecord[] {
    const ids = (status === undefined
      ? this.#db.prepare("SELECT id FROM tasks WHERE project_id = ? ORDER BY updated_at DESC, id").all(projectId)
      : this.#db.prepare("SELECT id FROM tasks WHERE project_id = ? AND status = ? ORDER BY updated_at DESC, id").all(projectId, status)) as Row[];
    return ids.map((r) => this.get(String(r["id"])) as TaskRecord);
  }

  #task(taskId: string): { projectId: string; lastSeq: number } {
    const r = this.#db.prepare("SELECT project_id, last_seq FROM tasks WHERE id = ?").get(taskId) as Row | undefined;
    return r === undefined ? NOT_FOUND() : { projectId: String(r["project_id"]), lastSeq: Number(r["last_seq"]) };
  }

  #checkBytes(projectId: string, adding: number): void {
    const used = Number((this.#db.prepare(`SELECT ${projectTaskBytesSql("?1")} AS n`).get(projectId) as Row)["n"]);
    if (used + adding > TASK_LIMITS.projectBytes) refuse("E_CONFLICT", "limit_reached", "The project holds its maximum of task text");
  }

  #insert(taskId: string, seq: number, title: string, body: string, author: TaskAuthor, at: string): void {
    const hop = author.kind === "user" ? 0 : author.hop;
    this.#db
      .prepare("INSERT INTO task_revisions (task_id, seq, title, body, bytes, author_kind, author_id, hop, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(taskId, seq, title, body, bytesOf(title) + bytesOf(body), author.kind, authorIdOf(author), hop, at);
  }
}
