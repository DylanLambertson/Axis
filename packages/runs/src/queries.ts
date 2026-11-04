// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AuditActions, AxisError, wellFormed, type AuditActor, type InstanceLock } from "@axis/audit";
import { RESTART_REASON, type RecoveryReport } from "@axis/journal";
import { z } from "zod";
import { RUN_AUDIT_ACTIONS } from "./audit.js";
import { SupervisorCore } from "./core.js";
import type { Disposable, RunWorktree } from "./ports.js";
import { RUN_REASONS, deriveWorkspaceStatus, type WorkspaceRunStatus } from "./status.js";
import type { RunEvent, RunSummary } from "./types.js";
import { noControl, pathKey } from "./util.js";

const MAX_LISTENERS = 32;
const MAX_LEASES = 64;
const TAIL_WINDOW = 16_384;
const MAX_TAIL = 8192;
const idText = z.string().min(1).max(128).refine(noControl);
const actorSchema = z.string().regex(/^(?:user|daemon|agent:[A-Za-z0-9._-]{1,64})$/);

export interface GitOperationLease {
  release(): void;
}

/** Reads, the commit and push guard, recovery and shutdown. */
export abstract class SupervisorQueries extends SupervisorCore {
  /** Status changes. Bounded: a 33rd listener is refused. A throwing listener is counted and skipped. */
  onChange(listener: (e: RunEvent) => void): Disposable {
    this.assertOpen();
    if (typeof listener !== "function") throw new AxisError("E_INVALID_ARGUMENT", "A listener must be a function");
    if (this.listeners.size >= MAX_LISTENERS) throw new AxisError("E_BACKPRESSURE", "Too many run listeners");
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  get(runId: string): RunSummary {
    if (!idText.safeParse(runId).success) throw new AxisError("E_INVALID_ARGUMENT", "Invalid run id");
    return this.mustSummary(runId);
  }

  list(options: { readonly workspaceId?: string; readonly limit?: number } = {}): RunSummary[] {
    const w = options.workspaceId === undefined ? undefined : idText.safeParse(options.workspaceId);
    if (w && !w.success) throw new AxisError("E_INVALID_ARGUMENT", "Invalid workspace id");
    const limit = Math.min(1000, Math.max(1, Math.trunc(options.limit ?? 200) || 200));
    const runs = this.o.journal.listRuns(w ? { workspaceId: w.data } : {}).filter((r) => r.kind === "cli");
    return runs.slice(-limit).map((r) => this.summary(r, this.byId.get(r.id)));
  }

  /**
   * Recent output of a live run, redacted on read so a secret split across two chunks is still caught. The
   * redactor sees up to 16 KiB; the answer is the last part of that, so a secret cut at the window's start only
   * loses text that is not returned. Terminal escape sequences are left in place for the terminal to draw.
   */
  tail(runId: string, maxChars = 4096): string {
    if (!idText.safeParse(runId).success) throw new AxisError("E_INVALID_ARGUMENT", "Invalid run id");
    const live = this.byId.get(runId);
    if (!live || live.released) throw new AxisError("E_NOT_FOUND", "No live output for that run");
    const n = Math.min(MAX_TAIL, Math.max(1, Math.trunc(maxChars) || 1));
    try {
      const redacted = this.o.redactor.redactString(live.ring.tail(TAIL_WINDOW));
      return wellFormed(redacted.slice(Math.max(0, redacted.length - n)));
    } catch {
      this.report("tail", "E_INTERNAL");
      return "";
    }
  }

  resize(runId: string, cols: number, rows: number): void {
    const live = this.byId.get(runId);
    if (!live || !live.handle || live.phase !== "running") throw new AxisError("E_NOT_FOUND", "No running process for that run");
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 10 || cols > 1000 || rows < 2 || rows > 1000) {
      throw new AxisError("E_INVALID_ARGUMENT", "Invalid terminal size");
    }
    try {
      live.handle.resize(cols, rows);
    } catch {
      this.report("resize", "E_INTERNAL");
    }
  }

  /** The dashboard row's run status for a workspace: idle, running, quiet, failed or done. */
  workspaceStatus(workspaceId: string): WorkspaceRunStatus {
    return deriveWorkspaceStatus(this.list({ workspaceId, limit: 50 }));
  }

  hasActiveRun(workspaceId: string): boolean {
    for (const l of this.live) if (l.workspaceId === workspaceId) return true;
    return false;
  }

  /**
   * The `isCliRunActive` dependency of `@axis/git-ops`. True while any Axis-launched run in that worktree can own a
   * process: starting (a spawn may be pending or hung), running, stopping, or a kill nobody confirmed. An exited run
   * does not count and neither does a CLI the user started by hand. A reference this cannot read counts as active.
   */
  readonly isCliRunActive = (worktree: RunWorktree): boolean => {
    const keys = this.keysOf(worktree);
    if (!keys) return true;
    for (const l of this.live) {
      if (l.released) continue;
      if (keys.includes(pathKey(l.worktree.workTree)) || keys.includes(pathKey(l.worktree.gitDir))) return true;
    }
    return false;
  };

  /**
   * Close the gap between "no run is active" and "git runs": hold the worktree against new runs while an Axis commit
   * or push executes. Throws `E_CONFLICT` if a run is active. The lease expires after `maxMs` so a caller that dies
   * cannot block a workspace forever; call `release()` when git is done.
   */
  acquireGitOperation(worktree: RunWorktree, options: { readonly maxMs?: number } = {}): GitOperationLease {
    this.assertOpen();
    const keys = this.keysOf(worktree);
    if (!keys) throw new AxisError("E_INVALID_ARGUMENT", "Invalid worktree reference");
    const maxMs = options.maxMs ?? 120_000;
    if (!Number.isInteger(maxMs) || maxMs < 1 || maxMs > 600_000) throw new AxisError("E_INVALID_ARGUMENT", "Invalid lease duration");
    if (this.isCliRunActive(worktree)) throw new AxisError("E_CONFLICT", "A CLI run is active in this workspace");
    if (this.leases.size >= MAX_LEASES) throw new AxisError("E_BACKPRESSURE", "Too many git operations in progress");
    const id = Symbol("lease");
    const timer = this.o.clock.setTimeout(() => void this.leases.delete(id), maxMs);
    this.leases.set(id, { keys, timer });
    return {
      release: () => {
        const l = this.leases.get(id);
        if (!l) return;
        this.o.clock.clearTimeout(l.timer);
        this.leases.delete(id);
      },
    };
  }

  /**
   * DMN-7 for CLI runs. Needs the held instance lock, like `Journal.recover`. A run that was RUNNING becomes BLOCKED
   * (`INTERRUPTED_BY_RESTART`) through the journal; a CLI run still QUEUED never reached a process and becomes
   * CANCELLED with the same reason (the journal has no QUEUED -> BLOCKED). Nothing is resumed or re-adopted, and no
   * process is spawned. Refused while this supervisor holds any run.
   */
  recover(lock: InstanceLock): RecoveryReport & { readonly launchesCancelled: readonly string[] } {
    this.assertOpen();
    if (this.live.size > 0) throw new AxisError("E_CONFLICT", "Recovery must run before any run starts");
    const report = this.o.journal.recover(lock);
    const launchesCancelled: string[] = [];
    for (const run of this.o.journal.listRuns({ states: ["QUEUED"] })) {
      if (run.kind !== "cli") continue;
      try {
        this.o.journal.transitionRun(run.id, "CANCELLED", { reason: RESTART_REASON, actor: "daemon", expectedFrom: "QUEUED" });
      } catch {
        this.report("recover", "E_INTERNAL");
        continue;
      }
      launchesCancelled.push(run.id);
      this.audit("daemon", AuditActions.journalRecovery, `run:${run.id}`, "success", {
        from: "QUEUED", to: "CANCELLED", reason: RESTART_REASON, kind: run.kind, workspaceId: run.workspaceId,
      });
    }
    return { ...report, launchesCancelled };
  }

  /** The user dismisses an interrupted run. It is never resumed. */
  discardInterrupted(runId: string, actor: AuditActor): RunSummary {
    if (!idText.safeParse(runId).success || !actorSchema.safeParse(actor).success) throw new AxisError("E_INVALID_ARGUMENT", "Invalid request");
    const run = this.o.journal.getRun(runId);
    if (!run || run.kind !== "cli") throw new AxisError("E_NOT_FOUND", "Run not found");
    if (run.state !== "BLOCKED" || this.byId.has(runId)) throw new AxisError("E_CONFLICT", "Only an interrupted run can be discarded");
    const done = this.o.journal.transitionRun(runId, "CANCELLED", { reason: RUN_REASONS.userDiscarded, actor, expectedFrom: "BLOCKED" });
    this.audit(actor, RUN_AUDIT_ACTIONS.discard, `run:${runId}`, "success", {
      runId, workspaceId: run.workspaceId, from: "BLOCKED", to: "CANCELLED", reason: RUN_REASONS.userDiscarded,
    });
    return this.summary(done, undefined);
  }

  /**
   * Shut down: refuse new work, SIGKILL every live process, clear every timer and listener. Journal rows are left
   * as they are, so the next start's recovery marks them interrupted.
   */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    for (const live of [...this.live]) {
      this.signal(live, "SIGKILL");
      this.release(live);
    }
    for (const l of this.leases.values()) this.o.clock.clearTimeout(l.timer);
    this.leases.clear();
  }

  private keysOf(w: unknown): readonly string[] | undefined {
    if (typeof w !== "object" || w === null) return undefined;
    const { workTree, gitDir } = w as RunWorktree;
    if (typeof workTree !== "string" || typeof gitDir !== "string" || workTree.length === 0 || gitDir.length === 0) return undefined;
    return [pathKey(workTree), pathKey(gitDir)];
  }
}
