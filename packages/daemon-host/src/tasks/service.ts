// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError, type AuditEventInput } from "@axis/audit";
import type { Journal, TaskAuthor, TaskRecord, TaskRevisionMeta } from "@axis/journal";
import { MAX_TASKS_LIST, isTasksRefusal, type TasksRefusalCode, type TasksRequest, type TasksResponse } from "@axis/protocol";

/**
 * The tasks service (ticket PV-T1 slice 2a, `docs/design/tasks-store.md` §5) over `Journal.tasks`. Two callers, each attested
 * by its binding and never taken from a payload: the user's bridge connection (`axis.tasks/1`) and a composer run of a worker
 * (`read_task`, `list_tasks`, `create_task`, `update_task`, scoped to the worker's project).
 *
 * - **The author is the caller.** The user writes as `user`; a run writes as its worker, at the run's received hop; the store
 *   derives `untrusted` and the hop, and the table holds them.
 * - **Every write and its audit row are one transaction.** A row holds ids, kinds, a sequence number and a byte length,
 *   never a title or a body.
 * - **Refusals are closed.** A store refusal with a reason of the contract's set leaves as that reason; anything else is
 *   `E_INTERNAL` at the edge, with no text of its own.
 */
export type TaskCaller =
  | { readonly kind: "user" }
  | { readonly kind: "agent"; readonly agentId: string; readonly projectId: string; readonly runId: string; readonly receivedHop: number };
type WorkerCaller = Extract<TaskCaller, { kind: "agent" }>;

export class TasksRefusal extends Error {
  constructor(readonly code: TasksRefusalCode, readonly reason: string) {
    super(reason);
  }
}
const NOT_FOUND = (): never => {
  throw new TasksRefusal("E_NOT_FOUND", "not_found");
};

export const TASK_AUDIT = {
  create: "task.create", update: "task.update", status: "task.status", assign: "task.assign", link: "task.link", unlink: "task.unlink", delete: "task.delete", start: "task.start",
} as const;
const PAYLOAD = ["taskId", "projectId", "seq", "bytes", "authorKind", "callerKind", "runId", "status", "assigneeKind", "linkKind", "changed", "workerId", "workerKind", "untrusted", "hop"] as const;
export const TASKS_PAYLOAD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(Object.values(TASK_AUDIT).map((a) => [a, Object.freeze([...PAYLOAD])])),
);

export interface TasksServiceDeps {
  readonly journal: Pick<Journal, "tasks" | "getProject">;
  readonly audit: { append(input: AuditEventInput): unknown };
  readonly random: { bytes(n: number): Uint8Array };
}

type Author = { kind: "user" } | { kind: "agent"; agentId: string } | { kind: "plugin"; pluginId: string } | { kind: "integration"; integrationId: string } | { kind: "system" };
export function taskAuthorWire(a: TaskAuthor): Author {
  switch (a.kind) {
    case "agent": return { kind: "agent", agentId: a.agentId };
    case "plugin": return { kind: "plugin", pluginId: a.pluginId };
    case "integration": return { kind: "integration", integrationId: a.integrationId };
    default: return { kind: a.kind };
  }
}
export const revisionMetaWire = (m: TaskRevisionMeta) => ({ taskId: m.taskId, seq: m.seq, title: m.title, author: taskAuthorWire(m.author), hop: m.hop, createdAt: m.createdAt });

function closed(e: unknown): never {
  if (e instanceof AxisError) {
    const reason = (e.detail as { reason?: unknown }).reason;
    if (typeof reason === "string" && isTasksRefusal(e.code, reason)) throw new TasksRefusal(e.code as TasksRefusalCode, reason);
  }
  throw e;
}

export interface TasksService {
  list(req: TasksRequest<"list">): TasksResponse<"list">;
  get(req: TasksRequest<"get">): TasksResponse<"get">;
  revisions(req: TasksRequest<"revisions">): TasksResponse<"revisions">;
  create(caller: TaskCaller, req: TasksRequest<"create">): TasksResponse<"create">;
  update(caller: TaskCaller, req: TasksRequest<"update">): TasksResponse<"update">;
  setStatus(req: TasksRequest<"setStatus">): TasksResponse<"setStatus">;
  assign(req: TasksRequest<"assign">): TasksResponse<"assign">;
  link(req: TasksRequest<"link">): TasksResponse<"link">;
  unlink(req: TasksRequest<"unlink">): TasksResponse<"unlink">;
  delete(req: TasksRequest<"delete">): TasksResponse<"delete">;
  /** A task as a run may see it: only one of its worker's project, else `not_found`. */
  readForRun(caller: WorkerCaller, taskId: string, seq?: number): { readonly task: TaskRecord; readonly title: string; readonly body: string; readonly seq: number; readonly authors: readonly TaskAuthor[] };
  /** The project's tasks for a run: an untrusted task's title is never shown (ids, status and the flag only). */
  listForRun(caller: WorkerCaller): readonly { readonly taskId: string; readonly status: string; readonly untrusted: boolean; readonly title: string | null }[];
}

export function createTasksService(deps: TasksServiceDeps): TasksService {
  const store = deps.journal.tasks;
  const bytes = (t: { title: string; body: string }): number => Buffer.byteLength(t.title, "utf8") + Buffer.byteLength(t.body, "utf8");
  const audit = (caller: TaskCaller, action: string, taskId: string, projectId: string, extra: Record<string, unknown> = {}): void => {
    deps.audit.append({
      actor: caller.kind === "user" ? "user" : `agent:${caller.agentId}`,
      action,
      target: `task:${taskId}`,
      outcome: "success",
      payload: { taskId, projectId, callerKind: caller.kind, ...(caller.kind === "agent" ? { runId: caller.runId } : {}), ...extra },
    });
  };
  const authorOf = (c: TaskCaller): TaskAuthor => (c.kind === "user" ? { kind: "user" } : { kind: "agent", agentId: c.agentId, hop: c.receivedHop });
  const id = (): string => `t${Buffer.from(deps.random.bytes(16)).toString("hex")}`;
  const scoped = (caller: TaskCaller, taskId: string): string => {
    const projectId = store.projectOf(taskId);
    if (projectId === undefined || (caller.kind === "agent" && projectId !== caller.projectId)) return NOT_FOUND();
    return projectId;
  };
  const current = (taskId: string) => {
    const r = store.revision(taskId);
    if (r === undefined) throw new AxisError("E_INTERNAL", "A task has no revision");
    return r;
  };
  const taskWire = (t: TaskRecord) => ({
    taskId: t.taskId, projectId: t.projectId, source: t.source, status: t.status, title: current(t.taskId).title,
    assignee: t.assignee, untrusted: t.untrusted, hop: t.hop, lastSeq: t.lastSeq, links: t.links.map((l) => ({ ...l })),
    createdAt: t.createdAt, updatedAt: t.updatedAt,
  });
  const write = <T>(fn: () => T): T => {
    try {
      return store.transaction(fn);
    } catch (e) {
      return closed(e);
    }
  };
  const get = (taskId: string): TaskRecord => store.get(taskId) ?? NOT_FOUND();
  return {
    list: (req) => {
      if (deps.journal.getProject(req.projectId) === undefined) return NOT_FOUND();
      const all = store.list(req.projectId, req.status);
      const after = req.after;
      const start = after === undefined ? 0 : all.findIndex((t) => t.updatedAt < after.updatedAt || (t.updatedAt === after.updatedAt && t.taskId > after.taskId));
      const page = start < 0 ? [] : all.slice(start, start + MAX_TASKS_LIST);
      return { tasks: page.map(taskWire), more: start >= 0 && start + MAX_TASKS_LIST < all.length };
    },
    get: (req) => {
      const t = get(req.taskId);
      const r = store.revision(req.taskId, req.seq);
      if (r === undefined) return NOT_FOUND();
      return { task: taskWire(t), revision: { meta: revisionMetaWire(r), body: r.body } };
    },
    revisions: (req) => {
      try {
        return { revisions: store.revisions(req.taskId).map(revisionMetaWire) };
      } catch (e) {
        return closed(e);
      }
    },
    create: (caller, req) => {
      if (deps.journal.getProject(req.projectId) === undefined || (caller.kind === "agent" && caller.projectId !== req.projectId)) return NOT_FOUND();
      return write(() => {
        const t = store.create({ taskId: id(), projectId: req.projectId, title: req.title, body: req.body, author: authorOf(caller) as Exclude<TaskAuthor, { kind: "system" }> });
        audit(caller, TASK_AUDIT.create, t.taskId, t.projectId, { seq: t.lastSeq, bytes: bytes(req), authorKind: caller.kind === "user" ? "user" : "agent" });
        return { task: taskWire(t) };
      });
    },
    update: (caller, req) => {
      const projectId = scoped(caller, req.taskId);
      return write(() => {
        const t = store.update({ taskId: req.taskId, baseSeq: req.baseSeq, title: req.title, body: req.body, author: authorOf(caller) });
        audit(caller, TASK_AUDIT.update, t.taskId, projectId, { seq: t.lastSeq, bytes: bytes(req), authorKind: caller.kind === "user" ? "user" : "agent" });
        return { task: taskWire(t) };
      });
    },
    setStatus: (req) => {
      const projectId = scoped({ kind: "user" }, req.taskId);
      return write(() => {
        const t = store.setStatus(req.taskId, req.status);
        audit({ kind: "user" }, TASK_AUDIT.status, t.taskId, projectId, { status: req.status });
        return { task: taskWire(t) };
      });
    },
    assign: (req) => {
      const projectId = scoped({ kind: "user" }, req.taskId);
      return write(() => {
        const t = store.assign(req.taskId, req.assignee);
        audit({ kind: "user" }, TASK_AUDIT.assign, t.taskId, projectId, { assigneeKind: req.assignee?.kind ?? "none" });
        return { task: taskWire(t) };
      });
    },
    link: (req) => {
      const projectId = scoped({ kind: "user" }, req.taskId);
      return write(() => {
        const changed = store.link(req.taskId, req.link);
        audit({ kind: "user" }, TASK_AUDIT.link, req.taskId, projectId, { linkKind: req.link.kind, changed });
        return { task: taskWire(get(req.taskId)), changed };
      });
    },
    unlink: (req) => {
      const projectId = scoped({ kind: "user" }, req.taskId);
      return write(() => {
        const changed = store.unlink(req.taskId, req.link);
        audit({ kind: "user" }, TASK_AUDIT.unlink, req.taskId, projectId, { linkKind: req.link.kind, changed });
        return { task: taskWire(get(req.taskId)), changed };
      });
    },
    delete: (req) => {
      const projectId = scoped({ kind: "user" }, req.taskId);
      return write(() => {
        store.delete(req.taskId);
        audit({ kind: "user" }, TASK_AUDIT.delete, req.taskId, projectId);
        return { deleted: true as const };
      });
    },
    readForRun: (caller, taskId, seq) => {
      scoped(caller, taskId);
      const task = get(taskId);
      const r = store.revision(taskId, seq) ?? NOT_FOUND();
      const authors = store.revisions(taskId).map((m) => m.author);
      return { task, title: r.title, body: r.body, seq: r.seq, authors };
    },
    listForRun: (caller) =>
      store.list(caller.projectId).map((t) => ({ taskId: t.taskId, status: t.status, untrusted: t.untrusted, title: t.untrusted ? null : current(t.taskId).title })),
  };
}
