// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Handler, HandlerContext } from "@axis/daemon";
import {
  COMPOSER_RUNS_CONTRACT,
  COMPOSER_RUNS_VERSION,
  MAX_COMPOSER_RUNS_LIST,
  MAX_RUN_EVENTS,
  composerRunsMethods,
  type ComposerRunsMethod,
  type ComposerRunsRequest,
} from "@axis/protocol";
import { composerFailure, toComposerError } from "../composer/errors.js";
import type { ComposerRunsService } from "../ports/composer.js";
import type { ProjectMutex } from "../worktrees/project-mutex.js";
import type { HandlerRegistrar } from "./anchor-guard.js";

/**
 * `axis.runs/1` (docs/design/composer-runtime.md section 3) over the `ComposerRunsService` port. Who is calling comes
 * from `ctx.identity` only; every method refuses any actor but `user` behind the policy row, with `E_NOT_FOUND` (a
 * handler cannot raise `E_POLICY_DENIED`). The window that starts a run is the one its approvals go to, taken from the
 * attested identity, never from the payload. `start` runs under the project mutex of the worktrees binding (the same
 * instance), so a remove or finalise of the workspace cannot interleave with the run's creation. Every answer is checked
 * against the contract's response schema before it leaves; every error is a `DaemonError` of fixed text.
 */
export interface ComposerRunsHandlerDeps {
  readonly service: ComposerRunsService;
  readonly journal: { getWorkspace(id: string): { readonly projectId: string } | undefined };
  readonly mutex: Pick<ProjectMutex, "run">;
  /** True for a workspace the last reconcile reported. Refuses `start`; the other methods always work. */
  readonly needsAttention?: (workspaceId: string, method?: string) => boolean;
}

const DEFAULT_LIST = 50;
const DEFAULT_EVENTS = 100;

export function createComposerRunsHandlers(deps: ComposerRunsHandlerDeps): Readonly<Record<ComposerRunsMethod, Handler>> {
  const guarded =
    <M extends ComposerRunsMethod>(method: M, call: (payload: ComposerRunsRequest<M>, context: HandlerContext) => Promise<unknown> | unknown): Handler =>
    async (context: HandlerContext, payload: never): Promise<unknown> => {
      if (context.signal.aborted) throw composerFailure("E_CANCELLED");
      // Defence in depth behind the policy row: only the user's own attested connection works with composer runs.
      if (context.identity.actor !== "user") throw composerFailure("E_NOT_FOUND");
      let out: unknown;
      try {
        out = await call(payload as ComposerRunsRequest<M>, context);
      } catch (e) {
        throw toComposerError(e);
      }
      const checked = composerRunsMethods[method].response.safeParse(out);
      if (!checked.success) throw composerFailure("E_INTERNAL");
      return checked.data;
    };

  const start = guarded("start", async (req, context) => {
    const ws = deps.journal.getWorkspace(req.workspaceId);
    if (ws === undefined) throw composerFailure("E_NOT_FOUND");
    if (deps.needsAttention?.(req.workspaceId, "start") === true) throw composerFailure("E_UNAVAILABLE", "needs_attention");
    return deps.mutex.run(
      ws.projectId,
      () =>
        deps.service.start(
          {
            workspaceId: req.workspaceId,
            mode: req.mode,
            prompt: req.prompt,
            providerId: req.providerId,
            modelId: req.modelId,
            windowId: context.identity.windowId,
            ...(context.idempotencyKey === undefined ? {} : { idempotencyKey: context.idempotencyKey }),
          },
          context.signal,
        ),
      context.signal,
    );
  });

  return {
    start,
    cancel: guarded("cancel", (req) => ({ run: deps.service.cancel(req.runId) })),
    get: guarded("get", (req) => ({ run: deps.service.get(req.runId) })),
    list: guarded("list", (req) => {
      const limit = Math.min(req.limit ?? DEFAULT_LIST, MAX_COMPOSER_RUNS_LIST);
      return { runs: deps.service.list({ ...(req.workspaceId === undefined ? {} : { workspaceId: req.workspaceId }), limit }) };
    }),
    events: guarded("events", (req) => deps.service.events(req.runId, req.afterSeq ?? 0, Math.min(req.limit ?? DEFAULT_EVENTS, MAX_RUN_EVENTS))),
  };
}

/** Register `axis.runs/1` through the host's registrar (never the daemon itself). */
export function registerComposerRunsHandlers(registrar: HandlerRegistrar, deps: ComposerRunsHandlerDeps): void {
  registrar.register(COMPOSER_RUNS_CONTRACT, COMPOSER_RUNS_VERSION, createComposerRunsHandlers(deps));
}
