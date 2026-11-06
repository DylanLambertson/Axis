// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Journal, Run } from "@axis/journal";
import type { ComposerRun } from "@axis/protocol";
import { createRunBudget, type RunBudget, type RunBudgetLimits } from "@axis/providers";
import type { ComposerEngine, ComposerEventsPage, ComposerRunsService, ComposerStartInput } from "../ports/composer.js";
import { RunActivity, type ActivityLimits } from "./activity.js";
import { composerFailure } from "./errors.js";
import { destinationOf } from "./destination.js";
import { resolveToolCaps, runComposerLoop, type LoopEnd, type ToolCaps } from "./loop.js";

/**
 * Composer runs (docs/design/composer-runtime.md section 4): the journal record of each run, one active run per
 * workspace, a per-run budget (PRV-6), cancellation, the bounded activity stream and startup recovery.
 *
 * - **Journal first.** A run exists once `createRun` returned (QUEUED, kind `composer`, the request's idempotency key);
 *   it goes RUNNING before the loop starts and ends REVIEWING (every run passes review), FAILED with a short reason, or
 *   CANCELLED. Nothing is created when the provider, the model or the worktree cannot be resolved.
 * - **Shutdown writes nothing.** `dispose` aborts every loop and closes the service: a loop that ends after that does not
 *   touch the journal (nothing may write after the final anchor). The run stays RUNNING and the next start's
 *   `Journal.recover` makes it BLOCKED / `INTERRUPTED_BY_RESTART`; `recover` here cancels a QUEUED composer run.
 * - **Budget.** One `createRunBudget(limits)` per run, handed to the guard: it is asked before every provider request.
 */

export interface ComposerServiceDeps {
  readonly journal: Pick<Journal, "getWorkspace" | "createRun" | "getRun" | "listRuns" | "transitionRun">;
  readonly engine: ComposerEngine;
  readonly now: () => number;
  /** Per-run budget. Default: 200,000 tokens and 50 requests, no cost cap (design question 2). */
  readonly budget?: RunBudgetLimits;
  /** Live composer runs across the host. Default 8. */
  readonly maxActive?: number;
  readonly maxTurns?: number;
  /** Tool fan-out caps (review r1 S4); unset ones take `DEFAULT_TOOL_CAPS`. An invalid cap is refused here. */
  readonly toolCaps?: Partial<ToolCaps>;
  readonly activity?: ActivityLimits;
  readonly onInternalError?: (where: string) => void;
}

export interface ComposerService extends ComposerRunsService {
  /** Startup (after `Journal.recover`): a QUEUED composer run never reached its loop, so it is cancelled. */
  recover(): number;
  /** Live runs in a workspace (a loop the daemon drives now). */
  isLive(workspaceId: string): boolean;
  /** Settles when every loop has ended (tests and orderly shutdown). */
  idle(): Promise<void>;
  /** Abort every loop and stop writing. Idempotent. */
  dispose(): void;
}

interface Live {
  readonly runId: string;
  readonly workspaceId: string;
  readonly controller: AbortController;
  readonly budget: RunBudget;
  awaiting: number;
  done: Promise<void>;
}

export const DEFAULT_COMPOSER_BUDGET: RunBudgetLimits = Object.freeze({ maxTokens: 200_000, maxRequests: 50 });
const OPEN: readonly Run["state"][] = ["QUEUED", "RUNNING"];

export function createComposerService(deps: ComposerServiceDeps): ComposerService {
  const activity = new RunActivity(deps.now, deps.activity);
  const live = new Map<string, Live>();
  const maxActive = deps.maxActive ?? 8;
  const limits = deps.budget ?? DEFAULT_COMPOSER_BUDGET;
  createRunBudget(limits); // refuses invalid limits now, not at the first run
  const caps = resolveToolCaps(deps.toolCaps); // likewise
  let closed = false;

  const internal = (where: string): void => {
    try {
      deps.onInternalError?.(where);
    } catch {
      // a logging failure changes nothing
    }
  };

  function view(run: Run): ComposerRun {
    const l = live.get(run.id);
    const meta = activity.meta(run.id);
    const used = activity.usage(run.id);
    return {
      runId: run.id,
      workspaceId: run.workspaceId,
      mode: meta?.mode ?? null,
      providerId: meta?.providerId ?? null,
      modelId: meta?.modelId ?? null,
      state: run.state,
      reason: run.reason,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      live: l !== undefined,
      awaitingApproval: l !== undefined && l.awaiting > 0,
      usage: used ?? null,
    };
  }

  function composerRun(runId: string): Run {
    const run = deps.journal.getRun(runId);
    if (run === undefined || run.kind !== "composer") throw composerFailure("E_NOT_FOUND");
    return run;
  }

  async function drive(l: Live, start: () => Promise<LoopEnd>): Promise<void> {
    let end: LoopEnd;
    try {
      end = await start();
    } catch {
      internal("loop");
      end = { state: "FAILED", reason: "INTERNAL" };
    }
    live.delete(l.runId);
    if (closed) return; // shutdown: the journal keeps RUNNING, recovery makes it BLOCKED
    try {
      const opts = { actor: "daemon", expectedFrom: "RUNNING" } as const;
      const run = deps.journal.transitionRun(l.runId, end.state, end.reason === null ? opts : { ...opts, reason: end.reason });
      activity.push(l.runId, { type: "state", state: run.state, reason: run.reason });
    } catch {
      internal("transition");
    }
    activity.close(l.runId);
  }

  const service: ComposerService = {
    async start(input: ComposerStartInput, signal: AbortSignal) {
      if (closed) throw composerFailure("E_UNAVAILABLE", "shutting_down");
      const ws = deps.journal.getWorkspace(input.workspaceId);
      if (ws === undefined || ws.state === "REMOVED" || ws.state === "FAILED" || ws.state === "CREATING") throw composerFailure("E_NOT_FOUND");
      if (ws.state !== "READY") throw composerFailure("E_CONFLICT", "not_ready");
      const provider = deps.engine.provider(input.providerId);
      if (provider === undefined) throw composerFailure("E_NOT_FOUND", "provider_unknown");
      let models;
      try {
        models = await provider.listModels({ signal });
      } catch {
        signal.throwIfAborted();
        throw composerFailure("E_UNAVAILABLE", "provider_unavailable");
      }
      if (!models.some((m) => m.id === input.modelId)) throw composerFailure("E_NOT_FOUND", "model_unknown");
      // PRV-4: the destination is fixed by the selected provider and shown with each request; one that cannot be shown refuses the start.
      const destination = destinationOf(provider.descriptor);
      if (destination === undefined) throw composerFailure("E_UNAVAILABLE", "provider_unavailable");
      let build;
      try {
        build = await deps.engine.prepare(input.workspaceId);
      } catch {
        signal.throwIfAborted();
        throw composerFailure("E_UNAVAILABLE", "worktree_unavailable");
      }
      if (signal.aborted) throw composerFailure("E_CANCELLED");
      if (closed) throw composerFailure("E_UNAVAILABLE", "shutting_down");
      // Synchronous from here to the loop's start: no other start can interleave between the check and the record.
      // The active-run check comes before the journal's own idempotency replay: a retry whose daemon-side key entry is gone
      // while its run is still RUNNING answers `active_run`, not `replayed` (review r1 N5). The daemon's store normally
      // answers such a retry first; after a restart the run is BLOCKED and the replay works.
      const open = deps.journal.listRuns({ workspaceId: input.workspaceId, states: OPEN }).filter((r) => r.kind === "composer");
      if (open.length > 0) throw composerFailure("E_CONFLICT", "active_run");
      if (live.size >= maxActive) throw composerFailure("E_BACKPRESSURE");
      const created = deps.journal.createRun({
        workspaceId: input.workspaceId,
        kind: "composer",
        createdBy: "user",
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      });
      if (created.replayed) return { run: view(created.value), replayed: true };
      const runId = created.value.id;
      activity.open(runId, { mode: input.mode, providerId: input.providerId, modelId: input.modelId });
      const controller = new AbortController();
      const budget = createRunBudget(limits);
      const l: Live = { runId, workspaceId: input.workspaceId, controller, budget, awaiting: 0, done: Promise.resolve() };
      let tools;
      try {
        tools =
        input.mode === "ask"
          ? undefined
          : build({
              runId,
              workspaceId: input.workspaceId,
              windowId: input.windowId,
              mode: input.mode,
              onApproval: (note) => {
                if (note.state === "requested") l.awaiting += 1;
                else l.awaiting = Math.max(0, l.awaiting - 1);
                activity.push(runId, { type: "approval", ...note, reasons: [...note.reasons], paths: note.paths.map((p) => ({ ...p })) });
              },
            });
      } catch {
        // The run exists but can never be driven: end it now rather than leave it QUEUED until a restart.
        internal("tools");
        activity.close(runId);
        deps.journal.transitionRun(runId, "CANCELLED", { reason: "START_FAILED", actor: "daemon", expectedFrom: "QUEUED" });
        throw composerFailure("E_INTERNAL");
      }
      const running = deps.journal.transitionRun(runId, "RUNNING", { actor: "daemon", expectedFrom: "QUEUED" });
      live.set(runId, l);
      activity.push(runId, { type: "state", state: running.state, reason: null });
      l.done = drive(l, () =>
        runComposerLoop({
          runId,
          mode: input.mode,
          prompt: input.prompt,
          model: input.modelId,
          provider,
          tools,
          budget,
          destination,
          signal: controller.signal,
          emit: (e) => activity.push(runId, e),
          ...(deps.maxTurns === undefined ? {} : { maxTurns: deps.maxTurns }),
          caps,
        }),
      );
      return { run: view(running), replayed: false };
    },

    cancel(runId) {
      const run = composerRun(runId);
      const l = live.get(runId);
      if (l !== undefined) {
        l.controller.abort();
        return view(run);
      }
      // RUNNING but not driven by this daemon: its last transition could not be written (review r1 N7). Nothing runs it, so
      // the user may end it; otherwise the workspace would refuse every new run until a restart.
      const stranded = run.state === "RUNNING" && !closed;
      if (run.state !== "QUEUED" && run.state !== "BLOCKED" && !stranded) throw composerFailure("E_CONFLICT", "not_cancellable");
      return view(deps.journal.transitionRun(runId, "CANCELLED", { reason: "USER_CANCELLED", actor: "user", expectedFrom: run.state }));
    },

    get: (runId) => view(composerRun(runId)),

    list({ workspaceId, limit }) {
      const runs = deps.journal.listRuns(workspaceId === undefined ? {} : { workspaceId }).filter((r) => r.kind === "composer");
      return runs.slice(Math.max(0, runs.length - limit)).map(view);
    },

    events(runId, afterSeq, limit): ComposerEventsPage {
      composerRun(runId);
      return activity.read(runId, afterSeq, limit);
    },

    recover() {
      let n = 0;
      for (const run of deps.journal.listRuns({ states: ["QUEUED"] })) {
        if (run.kind !== "composer" || live.has(run.id)) continue;
        try {
          deps.journal.transitionRun(run.id, "CANCELLED", { reason: "INTERRUPTED_BY_RESTART", actor: "daemon", expectedFrom: "QUEUED" });
          n++;
        } catch {
          internal("recover");
        }
      }
      return n;
    },

    isLive: (workspaceId) => [...live.values()].some((l) => l.workspaceId === workspaceId),

    async idle() {
      await Promise.all([...live.values()].map((l) => l.done));
    },

    dispose() {
      if (closed) return;
      closed = true;
      for (const l of live.values()) l.controller.abort();
    },
  };
  return service;
}
