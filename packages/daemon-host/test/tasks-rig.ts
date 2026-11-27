// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { randomBytes } from "node:crypto";
import type { TestContext } from "node:test";
import { createTasksService, type TaskCaller, type TasksService } from "../src/index.js";
import { composerRig, type ComposerRig } from "./composer-rig.js";
import type { DeliveryRig } from "./messages-delivery-rig.js";

// The task tools' rig (PV-T1 slices 2a and 3): a composer rig whose runs may have a live worker, over the real tasks
// service, broker, approvals and loop.

export const USER: TaskCaller = { kind: "user" };
export const worker = (agentId: string, receivedHop = 0, projectId = "p"): TaskCaller => ({ kind: "agent", agentId, projectId, runId: "r-other", receivedHop });

export async function tasksRig(t: TestContext) {
  const holder: { svc?: TasksService } = {};
  const workers = new Map<string, { agentId: string; projectId: string }>();
  const lazy = new Proxy({} as TasksService, { get: (_t, k) => (holder.svc as unknown as Record<string | symbol, unknown>)[k] });
  const c: ComposerRig = await composerRig({ replies: [], tasks: { service: lazy, workerOf: (id) => workers.get(id) } });
  t.after(() => c.cleanup());
  for (const id of ["p", "q"]) if (c.journal.getProject(id) === undefined) c.journal.registerProject({ id, path: `/repo/${id}`, displayName: id, trusted: false, actor: "user" });
  const svc = createTasksService({ journal: c.journal, audit: c.audit, random: { bytes: (n) => randomBytes(n) } });
  holder.svc = svc;
  return {
    c,
    r: { c } as unknown as DeliveryRig,
    svc,
    run(agentId?: string, projectId = "p"): string {
      const id = c.journal.composer.createRun({ workspaceId: c.workspaceId, createdBy: "user" }, { mode: "agent", providerId: "mock", modelId: "mock-model" }).value.id;
      c.journal.transitionRun(id, "RUNNING");
      if (agentId !== undefined) workers.set(id, { agentId, projectId });
      return id;
    },
    drop: (runId: string) => void workers.delete(runId),
    /** Serve the run's task tools from `s` from now on (a wrapper over `svc`, to place an edit at a chosen moment). */
    use: (s: TasksService) => void (holder.svc = s),
    rows: (action: string) => c.audit.list({ limit: 2000 }).filter((e) => e.action === action).map((e) => e.payload as Record<string, unknown>),
  };
}
export const task = (svc: TasksService, title = "Fix it", body = "user text", projectId = "p") => svc.create(USER, { projectId, title, body }).task;
export const call = (name: string, input: Record<string, unknown>) => ({ name, input });
