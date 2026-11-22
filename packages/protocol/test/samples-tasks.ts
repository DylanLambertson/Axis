// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Fixed vectors of axis.tasks/1 (PV-T1 slice 1).
import type { Sample } from "./suite.js";

export const T0 = "2026-11-22T10:00:00.000Z";
export const T1 = "2026-11-22T10:00:05.000Z";

export const userTask = {
  taskId: "task-1", projectId: "proj-1", source: "user", status: "open", title: "Fix login", assignee: null, untrusted: false, hop: 0, lastSeq: 1,
  links: [{ kind: "pr", target: "42" }, { kind: "workspace", target: "ws-1" }], createdAt: T0, updatedAt: T1,
};
export const importedTask = {
  taskId: "task-2", projectId: "proj-1", source: "integration", status: "in_progress", title: "Crash on start", assignee: { kind: "agent", id: "agent-a" },
  untrusted: true, hop: 1, lastSeq: 3, links: [], createdAt: T0, updatedAt: T1,
};
export const agentRevision = { taskId: "task-2", seq: 3, title: "Crash on start", author: { kind: "agent", agentId: "agent-a" }, hop: 1, createdAt: T1 };
export const userRevision = { taskId: "task-1", seq: 1, title: "Fix login", author: { kind: "user" }, hop: 0, createdAt: T0 };

const K = "axis.tasks";
const req = (method: string, name: string, value: unknown, extra: Partial<Sample> = {}): Sample => ({ contract: K, method, side: "request", name, value, ...extra });
const res = (method: string, name: string, value: unknown, extra: Partial<Sample> = {}): Sample => ({ contract: K, method, side: "response", name, value, ...extra });

export const TASKS_SAMPLES: readonly Sample[] = [
  req("list", "a project's tasks", { projectId: "proj-1" }),
  req("list", "open tasks after a cursor", { projectId: "proj-1", status: "open", after: { updatedAt: T1, taskId: "task-9" } }),
  res("list", "two tasks", { tasks: [userTask, importedTask], more: false }),
  req("get", "the newest", { taskId: "task-1" }),
  req("get", "revision 2", { taskId: "task-2", seq: 2 }),
  res("get", "an imported task", { task: importedTask, revision: { meta: agentRevision, body: "Steps to reproduce" } }),
  req("revisions", "revisions", { taskId: "task-2" }),
  res("revisions", "two", { revisions: [agentRevision, { ...agentRevision, seq: 1, author: { kind: "integration", integrationId: "github" } }] }),
  req("create", "a task", { projectId: "proj-1", title: "Fix login", body: "steps" }),
  res("create", "the new task", { task: userTask }),
  req("update", "an edit", { taskId: "task-1", baseSeq: 1, title: "Fix login", body: "more" }),
  res("update", "the edited task", { task: userTask }),
  req("setStatus", "done", { taskId: "task-1", status: "done" }),
  res("setStatus", "the task", { task: userTask }),
  req("assign", "to an agent", { taskId: "task-1", assignee: { kind: "agent", id: "agent-a" } }),
  req("assign", "to nobody", { taskId: "task-1", assignee: null }),
  res("assign", "assigned", { task: importedTask }),
  req("link", "a pull request", { taskId: "task-1", link: { kind: "pr", target: "42" } }),
  res("link", "linked", { task: userTask, changed: true }),
  req("unlink", "a run", { taskId: "task-1", link: { kind: "run", target: "run-1" } }),
  res("unlink", "unlinked", { task: userTask, changed: false }),
  req("delete", "with its approval", { taskId: "task-1", approval: { challengeId: "A".repeat(43) } }),
  res("delete", "deleted", { deleted: true }),
];
