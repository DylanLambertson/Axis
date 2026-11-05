// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError, type AuditActor } from "@axis/audit";
import type { Run, RunState } from "@axis/journal";
import type { LiveRun, SnapshotVerdict } from "./live.js";
import { resolveLimits, DEFAULT_LIMITS, type RunLimits } from "./limits.js";
import type { Disposable, PtySignal, RunWorktree, TimerId } from "./ports.js";
import { deriveStatus } from "./status.js";
import { pathKey } from "./util.js";
import type { RunEvent, RunSummary, SupervisorOptions } from "./types.js";

/** State and helpers shared by the layers of `RunSupervisor`. Nothing here is public API. */
export abstract class SupervisorCore {
  readonly limits: RunLimits;
  protected readonly o: SupervisorOptions;
  protected readonly live = new Set<LiveRun>();
  protected readonly byId = new Map<string, LiveRun>();
  protected readonly listeners = new Set<(e: RunEvent) => void>();
  protected readonly leases = new Map<symbol, { readonly keys: readonly string[]; readonly timer: TimerId; lapsed: boolean }>();
  /** Post-run snapshot verdicts, newest last, bounded. Lost on restart, which reads as `unknown`. */
  protected readonly verdicts = new Map<string, SnapshotVerdict>();
  protected closed = false;
  /** Set by the first `start`: recovery is a startup step and must not run after it. */
  protected started = false;
  protected recovered = false;
  protected errorsInListeners = 0;

  constructor(options: SupervisorOptions) {
    this.o = options;
    this.limits = resolveLimits(options.limits ?? DEFAULT_LIMITS);
  }

  get listenerErrors(): number {
    return this.errorsInListeners;
  }

  /** Runs that can still own a process; what the per-device limit counts. */
  get activeCount(): number {
    return this.live.size;
  }

  protected transition(live: LiveRun, to: RunState, reason: string | null, exitCode?: number | null): boolean {
    if (!live.runId) return false;
    try {
      const run = this.o.journal.transitionRun(live.runId, to, {
        actor: "daemon",
        expectedFrom: live.state,
        ...(reason ? { reason } : {}),
        ...(exitCode !== null && exitCode !== undefined ? { exitCode } : {}),
      });
      live.state = run.state;
      this.emit(live);
      return true;
    } catch (e) {
      this.report("transition", e instanceof AxisError ? e.code : "E_INTERNAL");
      return false;
    }
  }

  /** A journal read that can only fail with a closed-set error: the raw cause (a path, a SQL message) never escapes. */
  protected read<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof AxisError) throw e;
      this.report("journal", "E_INTERNAL");
      throw new AxisError("E_UNAVAILABLE", "The run record could not be read");
    }
  }

  protected setVerdict(runId: string, v: SnapshotVerdict): void {
    this.verdicts.delete(runId);
    this.verdicts.set(runId, v);
    if (this.verdicts.size > 512) this.verdicts.delete(this.verdicts.keys().next().value as string);
  }

  protected summary(run: Run, live: LiveRun | undefined): RunSummary {
    const now = this.o.clock.now();
    const held = live !== undefined && !live.released ? live : undefined;
    return {
      runId: run.id,
      workspaceId: run.workspaceId,
      state: run.state,
      reason: run.reason,
      exitCode: run.exitCode,
      status: deriveStatus({ state: run.state, reason: run.reason, live: held?.view(), now, quietMs: this.limits.quietMs }),
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      live: held !== undefined,
      lastOutputAt: held && held.ring.totalChars > 0 ? held.lastActivityAt : null,
      outputChars: held?.ring.totalChars ?? 0,
      droppedChars: held?.ring.droppedChars ?? 0,
      snapshotAfter: held || run.state === "QUEUED" || run.state === "RUNNING" ? "pending" : (this.verdicts.get(run.id) ?? "unknown"),
    };
  }

  protected mustSummary(runId: string): RunSummary {
    const run = this.read(() => this.o.journal.getRun(runId));
    if (!run || run.kind !== "cli") throw new AxisError("E_NOT_FOUND", "Run not found");
    return this.summary(run, this.byId.get(runId));
  }

  protected emit(live: LiveRun): void {
    if (!live.runId || this.listeners.size === 0) return;
    let e: RunEvent;
    try {
      const run = this.o.journal.getRun(live.runId);
      if (!run) return;
      e = { runId: run.id, workspaceId: run.workspaceId, state: run.state, status: this.summary(run, live).status };
    } catch {
      // A failing journal read must not break the run, a release or a timer: the event is skipped.
      this.report("emit", "E_INTERNAL");
      return;
    }
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        this.errorsInListeners++;
      }
    }
  }

  /** A timer owned by `live`: cleared when the run is released, and silent once the supervisor is shut down. */
  protected after(live: LiveRun, ms: number, fn: () => void): void {
    if (live.released || live.phase === "exited") return;
    const t = this.o.clock.setTimeout(() => {
      live.timers.delete(t);
      if (!live.released && !this.closed) fn();
    }, ms);
    live.timers.add(t);
  }

  /** False only when `required` and the write failed. A failed optional write is reported and ignored. */
  protected audit(actor: AuditActor, action: string, target: string, outcome: "success" | "denied", payload: Record<string, unknown>, required = false): boolean {
    try {
      this.o.audit.append({ actor, action, target, outcome, payload });
      return true;
    } catch {
      this.report("audit", "E_INTERNAL");
      return !required;
    }
  }

  protected signal(live: LiveRun, signal: PtySignal): void {
    try {
      live.handle?.kill(signal);
    } catch {
      if (!live.reportedKillError) {
        live.reportedKillError = true;
        this.report("kill", "E_INTERNAL");
      }
    }
  }

  /** Release the slot, the active flag, every timer and every subscription. Idempotent. Only call it when no process can exist. */
  protected release(live: LiveRun): void {
    if (live.released) return;
    live.released = true;
    live.phase = "exited";
    live.abortSpawn?.();
    live.abortSpawn = undefined;
    for (const t of live.timers) this.o.clock.clearTimeout(t);
    live.timers.clear();
    for (const s of live.subs.splice(0)) this.disposeIt(s);
    this.live.delete(live);
    if (live.runId && this.byId.get(live.runId) === live) this.byId.delete(live.runId);
    this.emit(live);
  }

  protected cleanTree(v: unknown): RunWorktree | undefined {
    if (typeof v !== "object" || v === null) return undefined;
    const { workTree, gitDir } = v as RunWorktree;
    return typeof workTree === "string" && typeof gitDir === "string" && workTree.length > 0 && gitDir.length > 0
      ? Object.freeze({ workTree, gitDir })
      : undefined;
  }

  protected leased(tree: RunWorktree): boolean {
    const keys = [pathKey(tree.workTree), pathKey(tree.gitDir)];
    for (const l of this.leases.values()) if (l.keys.some((k) => keys.includes(k))) return true;
    return false;
  }

  protected disposeIt(d: Disposable): void {
    try {
      d.dispose();
    } catch {
      this.report("dispose", "E_INTERNAL");
    }
  }

  protected report(where: string, code: string): void {
    try {
      this.o.onInternalError?.(where, code);
    } catch {
      // The reporter must not break the run.
    }
  }

  protected safe(e: unknown): AxisError {
    return e instanceof AxisError ? e : new AxisError("E_INTERNAL", "The run could not be started");
  }

  protected assertOpen(): void {
    if (this.closed) throw new AxisError("E_UNAVAILABLE", "The run supervisor is shut down");
  }
}
