// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { Redactor } from "@axis/audit";
import { DEFAULT_ACTIVITY_BOUNDS, checkActivityBounds, type ActivityBounds, type ComposerRunRecord, type Journal, type Run } from "@axis/journal";
import type { ComposerRun } from "@axis/protocol";
import { createRunBudget, type BudgetHook, type RunBudget, type RunBudgetLimits } from "@axis/providers";
import type { ComposerEngine, ComposerEventsPage, ComposerRunsService, ComposerStartInput } from "../ports/composer.js";
import { RunActivity, type ActivityInput, type ActivityLimits } from "./activity.js";
import { createComposerBudget } from "./budget.js";
import { fromActivityRecords, toActivityRecord } from "./persist.js";
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
 * - **Budget.** One `createRunBudget(limits)` per run and one per-workspace budget seeded from the journal at each start
 *   (C10), asked in that order before every provider request; both totals are written to the journal (J2) before the
 *   guard is answered, so a restart cannot reset either (`./budget.ts`).
 * - **Records (J2).** Mode, provider and model are recorded with the run, in the same transaction; usage and every
 *   activity event (redacted, display-safe, bounded) are written as they happen. `get` and `events` answer from the
 *   journal once the run is no longer held in memory.
 */

export interface ComposerServiceDeps {
  readonly journal: Pick<Journal, "getWorkspace" | "getRun" | "listRuns" | "transitionRun" | "composer">;
  readonly engine: ComposerEngine;
  readonly now: () => number;
  /** Per-run budget. Default: 200,000 tokens and 50 requests, no cost cap (design question 2). */
  readonly budget?: RunBudgetLimits;
  /** Per-workspace budget across its composer runs (C10). Default: 2,000,000 tokens and 500 requests (design question 2). */
  readonly workspaceBudget?: RunBudgetLimits;
  /** Applied to every stored activity event and to the model id: the host's own, with its registered secrets (review j2 N2). */
  readonly redactor: Redactor;
  /**
   * Bounds of the activity kept in the journal. Default `DEFAULT_ACTIVITY_BOUNDS`. Refused when `maxActive` live runs at
   * their per-run caps would not fit the totals, so total eviction never has to reach a live run's rows (review j2 N4).
   */
  readonly storedActivity?: ActivityBounds;
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
  readonly budget: BudgetHook;
  awaiting: number;
  done: Promise<void>;
}

export const DEFAULT_COMPOSER_BUDGET: RunBudgetLimits = Object.freeze({ maxTokens: 200_000, maxRequests: 50 });
export const DEFAULT_WORKSPACE_BUDGET: RunBudgetLimits = Object.freeze({ maxTokens: 2_000_000, maxRequests: 500 });
const OPEN: readonly Run["state"][] = ["QUEUED", "RUNNING"];

export function createComposerService(deps: ComposerServiceDeps): ComposerService {
  const activity = new RunActivity(deps.now, deps.activity);
  const live = new Map<string, Live>();
  const maxActive = deps.maxActive ?? 8;
  const limits = deps.budget ?? DEFAULT_COMPOSER_BUDGET;
  createRunBudget(limits); // refuses invalid limits now, not at the first run
  const wsLimits = deps.workspaceBudget ?? DEFAULT_WORKSPACE_BUDGET;
  createRunBudget(wsLimits);
  const redactor = deps.redactor;
  if (!(redactor instanceof Redactor)) throw new TypeError("the composer service needs the host redactor");
  const stored = checkActivityBounds(deps.storedActivity ?? DEFAULT_ACTIVITY_BOUNDS);
  if (maxActive * stored.maxRunRows > stored.maxRows || maxActive * stored.maxRunBytes > stored.maxBytes) {
    throw new RangeError("stored activity totals must hold every live run at its per-run caps");
  }
  const caps = resolveToolCaps(deps.toolCaps); // likewise
  let closed = false;

  const internal = (where: string): void => {
    try {
      deps.onInternalError?.(where);
    } catch {
      // a logging failure changes nothing
    }
  };

  /** The journal's record of a run; undefined for a run made before J2 or a record that cannot be read. */
  function record(runId: string): ComposerRunRecord | undefined {
    try {
      return deps.journal.composer.get(runId);
    } catch {
      internal("record");
      return undefined;
    }
  }

  /** The live view, and the journal behind it. Nothing is written once the service is closed (shutdown). */
  function emit(runId: string, input: ActivityInput): void {
    const added = activity.push(runId, input);
    if (closed) return;
    for (const ev of added) {
      const row = toActivityRecord(ev, redactor);
      try {
        if (row === undefined || deps.journal.composer.append(runId, row, stored) !== "stored") internal("activity_dropped");
      } catch {
        internal("activity");
      }
    }
    if (input.type !== "usage") return;
    try {
      deps.journal.composer.recordUsage(runId, input.usage);
    } catch {
      internal("usage");
    }
  }

  function view(run: Run): ComposerRun {
    const l = live.get(run.id);
    const held = activity.meta(run.id);
    const used = activity.usage(run.id);
    const rec = held === undefined || used === undefined ? record(run.id) : undefined;
    const meta = held ?? rec;
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
      usage: used ?? rec?.usage ?? null,
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
      emit(l.runId, { type: "state", state: run.state, reason: run.reason });
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
      // The model id is stored with the run (J2): one the redactor would change (a URL with credentials) is refused.
      if (redactor.redactString(input.modelId) !== input.modelId) throw composerFailure("E_UNAVAILABLE", "provider_unavailable");
      const destination = destinationOf(provider.descriptor, input.modelId);
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
      // C10: the workspace's budget is seeded from what the journal says it spent, never from zero; one that cannot be read
      // refuses the start with nothing created.
      let workspaceBudget: RunBudget;
      try {
        workspaceBudget = createRunBudget(wsLimits, deps.journal.composer.workspaceBudget(input.workspaceId));
      } catch {
        internal("budget");
        throw composerFailure("E_INTERNAL");
      }
      const meta = { mode: input.mode, providerId: input.providerId, modelId: input.modelId };
      const created = deps.journal.composer.createRun(
        { workspaceId: input.workspaceId, createdBy: "user", ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }) },
        meta,
      );
      if (created.replayed) return { run: view(created.value), replayed: true };
      const runId = created.value.id;
      activity.open(runId, meta);
      const controller = new AbortController();
      const runBudget = createRunBudget(limits, record(runId)?.budget);
      const budget = createComposerBudget({
        run: runBudget,
        workspace: workspaceBudget,
        save: (run, workspace) => {
          if (closed) throw new Error("closed"); // nothing is written after shutdown; the journal keeps the reservation
          deps.journal.composer.recordBudget(runId, input.workspaceId, run, workspace);
        },
      });
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
                emit(runId, { type: "approval", ...note, reasons: [...note.reasons], paths: note.paths.map((p) => ({ ...p })) });
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
      emit(runId, { type: "state", state: running.state, reason: null });
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
          emit: (e) => emit(runId, e),
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
      if (activity.meta(runId) !== undefined) return activity.read(runId, afterSeq, limit);
      // No longer held (a restart, or evicted from memory): the journal's bounded copy.
      const rec = record(runId);
      if (rec === undefined) return { events: [], nextSeq: 0, complete: true, available: false };
      let rows;
      try {
        rows = deps.journal.composer.read(runId, afterSeq, limit);
      } catch {
        internal("activity_read");
        return { events: [], nextSeq: 0, complete: true, available: false };
      }
      const events = fromActivityRecords(rows);
      const running = live.has(runId);
      // Nothing stored after the cursor. Unlike the memory ring, the journal's total bound can evict a finished run's
      // newest row too (review j2 SF-1): for a run nobody drives, the cursor moves to its last sequence number and the
      // page is complete, so a client never polls a run whose rows are gone forever.
      const empty = running ? Math.min(afterSeq, rec.lastSeq) : Math.max(afterSeq, rec.lastSeq);
      const nextSeq = events.at(-1)?.seq ?? rows.at(-1)?.seq ?? empty;
      return { events, nextSeq, complete: !running && nextSeq >= rec.lastSeq, available: true };
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
