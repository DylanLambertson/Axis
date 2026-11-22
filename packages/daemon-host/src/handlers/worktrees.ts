// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { projectGated, type ProjectTrustGate } from "../gate/project-trust.js";
import { DaemonError, type Handler, type HandlerContext } from "@axis/daemon";
import type { WorktreesMethod, WorktreesRequest } from "@axis/protocol";
import type { PortContext } from "../ports/common.js";
import type { WorktreesService } from "../ports/worktrees.js";
import { toDaemonError, worktreeFailure } from "../worktrees/errors.js";

/**
 * `axis.worktrees/1` (design section 4.2): eight methods over the `WorktreesService` port. Nothing here touches a path, git
 * or the journal. Who is calling comes from `ctx.identity` only (the payload names a workspace, never an actor), and
 * the only thing taken from a spent approval is `ctx.approved.capability`, passed through untouched for the service to
 * hand to the manager: a handler never makes one. A workspace the last reconcile found in disagreement answers
 * `E_UNAVAILABLE` (reason `needs_attention`) instead of being worked on. Every error is a `DaemonError` with a fixed text
 * (`toDaemonError`), never the text of whatever failed.
 */
export interface WorktreesHandlerDeps {
  readonly service: WorktreesService;
  /** The project trust gate: handed to the service as `PortContext.trust` for create, restore and discard. */
  readonly gate: ProjectTrustGate;
  /** True for a workspace the last reconcile reported (see `createWorktreesBinding`). */
  readonly needsAttention: (workspaceId: string, method?: string) => boolean;
}

function portContext(context: HandlerContext): PortContext {
  const { identity, signal, approved } = context;
  return {
    caller: { actor: identity.actor, connectionId: identity.connectionId, windowId: identity.windowId },
    signal,
    ...(approved?.capability === undefined ? {} : { confirmation: approved.capability }),
  };
}

/** The gate bound to this caller's window and signal, for a gated method only. */
const trustFor = (gate: ProjectTrustGate, context: HandlerContext) => (scope: { readonly projectId: string; readonly workspaceId?: string }) =>
  gate.admit({ ...scope, windowId: context.identity.windowId, signal: context.signal });

const notServed = (): Promise<never> => Promise.reject(worktreeFailure("E_UNAVAILABLE", "not_available"));

export function createWorktreesHandlers(deps: WorktreesHandlerDeps): Readonly<Record<WorktreesMethod, Handler>> {
  const withTrust = (ctx: PortContext, context: HandlerContext): PortContext => ({ ...ctx, trust: trustFor(deps.gate, context) });
  const run =
    <M extends WorktreesMethod>(
      method: M,
      ids: (payload: WorktreesRequest<M>) => readonly string[],
      call: (payload: WorktreesRequest<M>, ctx: PortContext, context: HandlerContext) => Promise<unknown>,
    ): Handler =>
    async (context: HandlerContext, payload: never): Promise<unknown> => {
      if (context.signal.aborted) throw new DaemonError("E_CANCELLED", "The request was cancelled.");
      // Defence in depth behind the policy row: only the user's own attested connection works on workspaces.
      if (context.identity.actor !== "user") throw worktreeFailure("E_NOT_FOUND");
      const request = payload as WorktreesRequest<M>;
      try {
        if (ids(request).some((id) => deps.needsAttention(id, method))) throw worktreeFailure("E_UNAVAILABLE", "needs_attention");
        return await call(request, portContext(context), context);
      } catch (e) {
        throw toDaemonError(e);
      }
    };
  const none = (): readonly string[] => [];
  // An approved method must run inside a spent approval: the daemon guarantees it, and a handler that finds otherwise stops.
  const approved = (context: HandlerContext): void => {
    if (context.approved === undefined) throw new DaemonError("E_INTERNAL", "The worktree operation failed.");
  };
  return {
    list: run<"list">("list", none, (p, ctx) => deps.service.list(p, ctx)),
    status: run<"status">("status", (p) => p.ids, (p, ctx) => deps.service.status(p, ctx)),
    create: projectGated(run<"create">("create", none, (p, ctx, context) => deps.service.create(p, withTrust(ctx, context)))),
    finalise: run<"finalise">("finalise", (p) => [p.id], (p, ctx, context) => (approved(context), deps.service.finalise(p, ctx))),
    remove: run<"remove">("remove", (p) => [p.id], (p, ctx, context) => (approved(context), deps.service.remove(p, ctx))),
    restoreFromRunBase: projectGated(run<"restoreFromRunBase">("restoreFromRunBase", (p) => [p.id], (p, ctx, context) => deps.service.restoreFromRunBase(p, withTrust(ctx, context)))),
    // The contract and policy rows exist (ticket P1d); the service behind them does not (it needs a discard entry point and a
    // user-editing set in `@axis/worktrees`). Until then both answer a fixed refusal and touch nothing.
    // Not served yet; registered gated so the row and its handler agree when it is.
    discard: projectGated(run<"discard">("discard", (p) => [p.id], notServed)),
    setUserEditing: run<"setUserEditing">("setUserEditing", (p) => [p.id], notServed),
  };
}
