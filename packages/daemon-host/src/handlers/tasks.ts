// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError, type Handler, type HandlerContext } from "@axis/daemon";
import { TASKS_CONTRACT, TASKS_REFUSAL_MESSAGE, TASKS_VERSION, tasksMethods, type TasksMethod, type TasksRequest } from "@axis/protocol";
import { TasksRefusal, type TaskCaller, type TasksService } from "../tasks/service.js";
import type { HandlerRegistrar } from "./anchor-guard.js";

/**
 * `axis.tasks/1` over the bridge (ticket PV-T1 slice 2a, docs/design/tasks-store.md §5). The user's own attested desktop
 * connection only: the rows admit only `user`, and every handler refuses any other actor and a web client again with
 * `not_found`. The caller is built here from `ctx.identity`, never from the payload. `delete` is tier 4: the pipeline runs
 * it only after main's native dialog confirmed its challenge with the proof; the renderer's own `resolve` never does.
 *
 * Every refusal leaves as `{ code, TASKS_REFUSAL_MESSAGE, details: { reason } }` of the contract's closed set; anything else
 * (a store reason the contract does not have, a database error) is `E_INTERNAL` with no text of its own. Every answer is
 * checked against the method's response schema before it leaves.
 */
const fail = (code: "E_CANCELLED" | "E_INTERNAL" | "E_NOT_FOUND" | "E_CONFLICT" | "E_INVALID_ARGUMENT", reason?: string): never => {
  throw new DaemonError(code, code === "E_CANCELLED" ? "The request was cancelled." : code === "E_INTERNAL" ? "Request failed" : TASKS_REFUSAL_MESSAGE, reason === undefined ? undefined : { reason });
};

export function toTasksError(e: unknown): never {
  if (e instanceof DaemonError) throw e;
  if (e instanceof TasksRefusal) return fail(e.code as "E_NOT_FOUND", e.reason);
  return fail("E_INTERNAL");
}

const USER: TaskCaller = Object.freeze({ kind: "user" });

export function createTasksHandlers(service: TasksService): Readonly<Record<TasksMethod, Handler>> {
  const guarded =
    <M extends TasksMethod>(method: M, call: (payload: TasksRequest<M>) => unknown): Handler =>
    async (context: HandlerContext, payload: never): Promise<unknown> => {
      if (context.signal.aborted) return fail("E_CANCELLED");
      if (context.identity.actor !== "user" || context.identity.clientKind !== "desktop") return fail("E_NOT_FOUND", "not_found");
      let out: unknown;
      try {
        out = call(payload as TasksRequest<M>);
      } catch (e) {
        return toTasksError(e);
      }
      const checked = tasksMethods[method].response.safeParse(out);
      if (!checked.success) return fail("E_INTERNAL");
      return checked.data;
    };
  return {
    list: guarded("list", (p) => service.list(p)),
    get: guarded("get", (p) => service.get(p)),
    revisions: guarded("revisions", (p) => service.revisions(p)),
    create: guarded("create", (p) => service.create(USER, p)),
    update: guarded("update", (p) => service.update(USER, p)),
    setStatus: guarded("setStatus", (p) => service.setStatus(p)),
    assign: guarded("assign", (p) => service.assign(p)),
    link: guarded("link", (p) => service.link(p)),
    unlink: guarded("unlink", (p) => service.unlink(p)),
    delete: guarded("delete", (p) => service.delete(p)),
  };
}

/** Register `axis.tasks/1` through the host's registrar (never the daemon itself). */
export function registerTasksHandlers(registrar: HandlerRegistrar, service: TasksService): void {
  registrar.register(TASKS_CONTRACT, TASKS_VERSION, createTasksHandlers(service));
}
