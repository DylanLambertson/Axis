// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { basename } from "node:path";
import { AxisError, type AuditActor } from "@axis/audit";
import type { Run, RunState } from "@axis/journal";
import { cliAgentSchema, resolveLaunch, type CliAgent, type LaunchRefusal } from "@axis/pty-policy";
import { z } from "zod";
import { TrustAttestation } from "./attestation.js";
import { RUN_AUDIT_ACTIONS } from "./audit.js";
import { DISCLOSURE_VERSION } from "./copy.js";
import { LiveRun } from "./live.js";
import type { PtyExit, PtyHandle } from "./ports.js";
import { SupervisorQueries } from "./queries.js";
import { RUN_REASONS } from "./status.js";
import type { RunSummary, StartRequest } from "./types.js";
import { noControl, timed } from "./util.js";

const ACTOR = /^(?:user|daemon|agent:[A-Za-z0-9._-]{1,64})$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const idText = z.string().min(1).max(128).refine(noControl);
const actorSchema = z.string().regex(ACTOR);
const REFUSAL_MAP: Record<LaunchRefusal, readonly [AxisError["code"], string]> = {
  UNTRUSTED: ["E_POLICY_DENIED", "The source repository is not trusted"],
  BAD_WORKTREE: ["E_INVALID_ARGUMENT", "The worktree path is not acceptable"],
  INVALID_AGENT: ["E_INVALID_ARGUMENT", "The CLI definition is not acceptable"],
  INVALID_ENV: ["E_INTERNAL", "The resolved environment is not usable"],
  EXECUTABLE_NOT_FOUND: ["E_NOT_FOUND", "The CLI executable was not found outside the worktree"],
};

export class RunSupervisor extends SupervisorQueries {
  // ---- start ----

  async start(request: StartRequest): Promise<{ readonly run: RunSummary; readonly replayed: boolean }> {
    this.assertOpen();
    if (typeof request !== "object" || request === null) throw new AxisError("E_INVALID_ARGUMENT", "Invalid run start request");
    // One read of each field: a getter or Proxy cannot answer differently later.
    const { workspaceId, agent: rawAgent, actor, trust, idempotencyKey } = request as StartRequest;
    const shape = z
      .object({ workspaceId: idText, actor: actorSchema, key: z.string().regex(UUID_V4).optional() })
      .safeParse({ workspaceId, actor, key: idempotencyKey });
    if (!shape.success) throw new AxisError("E_INVALID_ARGUMENT", "Invalid run start request");
    const who = shape.data.actor as AuditActor;
    const ws = shape.data.workspaceId;
    const refuse = (code: AxisError["code"], reason: string, message: string): never => {
      this.audit(who, RUN_AUDIT_ACTIONS.refused, `workspace:${ws}`, "denied", { workspaceId: ws, code, reason });
      throw new AxisError(code, message, { reason });
    };

    const early = TrustAttestation.check(trust, { workspaceId: ws, projectId: undefined, now: this.o.clock.now(), ttlMs: this.limits.attestationTtlMs }, false);
    if (early) return refuse("E_POLICY_DENIED", early, "A run needs main's trust attestation for this workspace");
    const parsedAgent = cliAgentSchema.safeParse(rawAgent);
    if (!parsedAgent.success) return refuse("E_INVALID_ARGUMENT", "INVALID_AGENT", "The CLI definition is not acceptable");
    const agent: Readonly<CliAgent> = Object.freeze(parsedAgent.data);

    const located = await timed(this.o.clock, this.limits.snapshotTimeoutMs, () => this.o.locator.locate(ws));
    const tree = located.ok ? this.cleanTree(located.value) : undefined;
    if (!tree) return refuse("E_NOT_FOUND", "WORKTREE_UNAVAILABLE", "The workspace worktree could not be located");

    // ---- from here to the reservation there is no await: the limit check and the slot cannot be separated ----
    this.assertOpen();
    const workspace = this.o.journal.getWorkspace(ws);
    if (!workspace) return refuse("E_NOT_FOUND", "WORKSPACE_NOT_FOUND", "Workspace not found");
    if (workspace.state !== "READY") return refuse("E_CONFLICT", "WORKSPACE_NOT_READY", "Runs can only start in a READY workspace");
    if (this.leased(tree)) return refuse("E_CONFLICT", "GIT_OPERATION_ACTIVE", "An Axis commit or push is in progress in this workspace");
    if (this.live.size >= this.limits.maxConcurrent) return refuse("E_BACKPRESSURE", "RUN_LIMIT", "Too many CLI runs are active on this device");
    const bad = TrustAttestation.check(trust, { workspaceId: ws, projectId: workspace.projectId, now: this.o.clock.now(), ttlMs: this.limits.attestationTtlMs }, true);
    if (bad) return refuse("E_POLICY_DENIED", bad, "A run needs main's trust attestation for this workspace");
    const live = new LiveRun(ws, tree, who, agent, this.limits.outputBufferChars, this.o.clock.now());
    this.live.add(live);
    // ---- reserved ----

    try {
      const out = await this.launch(live, trust, shape.data.key);
      if (!live.processPossible) this.release(live);
      return out;
    } catch (e) {
      if (live.runId && live.state === "QUEUED" && !live.processPossible && !live.finalised) this.transition(live, "CANCELLED", RUN_REASONS.internal);
      if (!live.processPossible) this.release(live);
      throw this.safe(e);
    }
  }

  private async launch(live: LiveRun, trust: TrustAttestation, key: string | undefined): Promise<{ run: RunSummary; replayed: boolean }> {
    const o = this.o;
    const prelaunch = this.resolve(live);
    if (!prelaunch.ok) throw this.refused(live, prelaunch);

    const created = o.journal.createRun({ workspaceId: live.workspaceId, kind: "cli", createdBy: live.actor, ...(key ? { idempotencyKey: key } : {}) });
    const id = created.value.id;
    if (created.replayed || this.byId.has(id)) {
      // Never a second process for one id: a replay returns what exists, a duplicate id is a journal fault.
      const existing = this.byId.get(id);
      if (created.replayed && existing) return { run: this.summary(created.value, existing), replayed: true };
      throw new AxisError(created.replayed ? "E_CONFLICT" : "E_INTERNAL", created.replayed ? "That start was already used and is not running" : "Run id collision");
    }
    live.runId = id;
    this.byId.set(id, live);
    this.emit(live);

    if (!this.audit(live.actor, RUN_AUDIT_ACTIONS.start, `run:${id}`, "success", {
      runId: id, workspaceId: live.workspaceId, agentId: live.agent.id, executable: basename(prelaunch.argv[0] as string),
      argCount: prelaunch.argv.length - 1, removedEnvCount: prelaunch.removed.length, disclosureVersion: DISCLOSURE_VERSION,
    }, true)) {
      this.transition(live, "CANCELLED", RUN_REASONS.auditFailed);
      throw new AxisError("E_INTERNAL", "The run could not be recorded in the audit log");
    }

    const snap = await timed(o.clock, this.limits.snapshotTimeoutMs, () => o.snapshotter.before({ runId: id, workspaceId: live.workspaceId, worktree: live.worktree }));
    if (!snap.ok) {
      this.transition(live, "CANCELLED", RUN_REASONS.snapshotFailed);
      throw new AxisError("E_UNAVAILABLE", "The pre-run snapshot did not complete, so the run was not started");
    }
    if (this.closed || live.stopRequested) {
      this.transition(live, "CANCELLED", RUN_REASONS.userKilled);
      throw new AxisError("E_CANCELLED", "The run was stopped before it started");
    }
    // Trust is re-derived at run start, not only at the call: stale after a slow snapshot means refused.
    if (!TrustAttestation.fresh(trust, o.clock.now(), this.limits.attestationTtlMs)) {
      this.transition(live, "CANCELLED", RUN_REASONS.launchRefused);
      throw new AxisError("E_POLICY_DENIED", "Trust was attested too long ago to start this run", { reason: "ATTESTATION_EXPIRED" });
    }
    // Resolve again and spawn in the same tick: the executable cannot change across the snapshot await.
    const launch = this.resolve(live);
    if (!launch.ok) {
      this.transition(live, "CANCELLED", RUN_REASONS.launchRefused);
      throw this.refused(live, launch);
    }

    live.phase = "spawning";
    live.processPossible = true;
    const outcome = await this.spawn(live, id, launch);
    if (outcome.kind === "failed") {
      live.processPossible = false;
      this.transition(live, "CANCELLED", RUN_REASONS.spawnFailed);
      throw new AxisError("E_UNAVAILABLE", "The CLI could not be started");
    }
    if (outcome.kind === "timeout" && this.closed) {
      // Shut down while waiting: the journal row stays as it is for recovery to interrupt.
      throw new AxisError("E_UNAVAILABLE", "The run supervisor is shut down");
    }
    if (outcome.kind === "timeout") {
      // The port may still produce a process: the run is cancelled but the slot stays held until the port settles.
      this.transition(live, "CANCELLED", RUN_REASONS.spawnTimeout);
      live.finalised = true;
      throw new AxisError("E_TIMEOUT", "The CLI did not start in time");
    }
    return { run: this.attach(live, id, outcome.handle), replayed: false };
  }

  private resolve(live: LiveRun): ReturnType<typeof resolveLaunch> {
    try {
      return this.resolveUnchecked(live);
    } catch {
      this.report("env", "E_INTERNAL");
      return { ok: false, code: "INVALID_ENV", message: "" };
    }
  }

  private resolveUnchecked(live: LiveRun): ReturnType<typeof resolveLaunch> {
    const o = this.o;
    return resolveLaunch({
      agent: live.agent,
      worktreeRoot: live.worktree.workTree,
      trusted: true, // the attestation was verified and spent by `start`
      parentEnv: o.env(),
      managedWorktreeRoots: o.managedWorktreeRoots?.() ?? [],
      ...(o.extensionVariableNames ? { extensionVariableNames: o.extensionVariableNames } : {}),
      ...(o.platform ? { platform: o.platform } : {}),
      ...(o.fs ? { fs: o.fs } : {}),
    });
  }

  private refused(live: LiveRun, r: Extract<ReturnType<typeof resolveLaunch>, { ok: false }>): AxisError {
    const [code, message] = REFUSAL_MAP[r.code];
    this.audit(live.actor, RUN_AUDIT_ACTIONS.refused, `workspace:${live.workspaceId}`, "denied", { workspaceId: live.workspaceId, code, reason: r.code });
    return new AxisError(code, message, { reason: r.code });
  }

  /** Spawn with a timeout. A handle that arrives after the timeout is killed and its exit awaited, then the slot is released. */
  private spawn(live: LiveRun, id: string, launch: Extract<ReturnType<typeof resolveLaunch>, { ok: true }>): Promise<{ kind: "handle"; handle: PtyHandle } | { kind: "failed" } | { kind: "timeout" }> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = this.o.clock.setTimeout(() => {
        if (settled) return;
        settled = true;
        live.abortSpawn = undefined;
        resolve({ kind: "timeout" });
      }, this.limits.startTimeoutMs);
      live.abortSpawn = () => {
        if (settled) return;
        settled = true;
        this.o.clock.clearTimeout(timer);
        resolve({ kind: "timeout" });
      };
      const onHandle = (handle: PtyHandle): void => {
        if (typeof handle !== "object" || handle === null || typeof handle.kill !== "function" || typeof handle.onExit !== "function" || typeof handle.onData !== "function") {
          // Not a usable process handle: there is nothing to supervise or to kill.
          onFail();
          return;
        }
        if (settled) {
          this.adoptLate(live, handle);
          return;
        }
        settled = true;
        live.abortSpawn = undefined;
        this.o.clock.clearTimeout(timer);
        resolve({ kind: "handle", handle });
      };
      const onFail = (): void => {
        if (!settled) {
          settled = true;
          live.abortSpawn = undefined;
          this.o.clock.clearTimeout(timer);
          resolve({ kind: "failed" });
        } else {
          // Rejected after the timeout: no process exists after all.
          live.processPossible = false;
          this.release(live);
        }
      };
      try {
        Promise.resolve(this.o.pty.spawn({ runId: id, argv: launch.argv, cwd: launch.cwd, env: launch.env, cols: this.limits.cols, rows: this.limits.rows })).then(onHandle, onFail);
      } catch {
        onFail();
      }
    });
  }

  /** Subscribe, move the journal to RUNNING, and honour a stop or exit that raced the spawn. */
  private attach(live: LiveRun, id: string, handle: PtyHandle): RunSummary {
    live.handle = handle;
    live.subscribing = true;
    try {
      live.subs.push(handle.onExit((e) => this.onExit(live, e)));
      live.subs.push(handle.onData((c) => this.onData(live, c)));
    } catch {
      // Without an exit subscription the process can never be confirmed dead: kill it and hold the slot.
      live.subscribing = false;
      this.report("subscribe", "E_INTERNAL");
      live.stopReason = RUN_REASONS.spawnFailed;
      this.transition(live, "CANCELLED", RUN_REASONS.spawnFailed);
      live.finalised = true;
      this.signal(live, "SIGKILL");
      throw new AxisError("E_UNAVAILABLE", "The CLI could not be supervised");
    }
    if (this.closed) {
      live.subscribing = false;
      this.signal(live, "SIGKILL");
      throw new AxisError("E_UNAVAILABLE", "The run supervisor is shut down");
    }
    if (live.stopRequested) {
      live.subscribing = false;
      live.phase = "stopping";
      if (live.pendingExit) this.onExit(live, live.pendingExit);
      else this.escalate(live);
      throw new AxisError("E_CANCELLED", "The run was stopped before it started");
    }
    live.phase = "running";
    const moved = this.transition(live, "RUNNING", null);
    live.subscribing = false;
    if (!moved) {
      live.stopRequested = true;
      live.stopReason = RUN_REASONS.journalFailed;
      live.phase = "stopping";
      if (live.pendingExit) this.onExit(live, live.pendingExit);
      else this.escalate(live);
      throw new AxisError("E_INTERNAL", "The run could not be recorded");
    }
    live.lastActivityAt = this.o.clock.now();
    this.armQuiet(live);
    const pending = live.pendingExit;
    if (pending) this.onExit(live, pending);
    return this.summary(this.o.journal.getRun(id) as Run, live);
  }

  private adoptLate(live: LiveRun, handle: PtyHandle): void {
    live.handle = handle;
    if (this.closed) {
      this.signal(live, "SIGKILL");
      return;
    }
    live.stopRequested = true;
    try {
      live.subs.push(handle.onExit((e) => this.onExit(live, e)));
    } catch {
      this.report("subscribe", "E_INTERNAL");
    }
    live.phase = "stopping";
    this.escalate(live);
  }

  // ---- process events ----

  private onData(live: LiveRun, chunk: string): void {
    if (live.phase === "exited" || live.released) {
      live.ignoredEvents++;
      return;
    }
    live.ring.append(chunk);
    live.lastActivityAt = this.o.clock.now();
    if (live.quiet) {
      live.quiet = false;
      this.emit(live);
      this.armQuiet(live);
    }
  }

  private armQuiet(live: LiveRun): void {
    this.after(live, Math.max(1, this.limits.quietMs - (this.o.clock.now() - live.lastActivityAt)), () => {
      if (live.phase !== "running" && live.phase !== "stopping") return;
      if (this.o.clock.now() - live.lastActivityAt >= this.limits.quietMs) {
        live.quiet = true;
        this.emit(live);
      } else {
        this.armQuiet(live);
      }
    });
  }

  private onExit(live: LiveRun, exit: PtyExit): void {
    if (live.phase === "exited" || live.released) {
      live.ignoredEvents++;
      return;
    }
    if (live.subscribing) {
      live.pendingExit ??= exit;
      return;
    }
    live.phase = "exited";
    live.processPossible = false;
    for (const t of live.timers) this.o.clock.clearTimeout(t);
    live.timers.clear();
    for (const s of live.subs.splice(0)) this.disposeIt(s);

    let rawCode: unknown;
    let rawSignal: unknown;
    try {
      rawCode = exit?.exitCode;
      rawSignal = exit?.signal;
    } catch {
      // A hostile exit object: treat as an exit with no usable code.
    }
    const code = typeof rawCode === "number" && Number.isInteger(rawCode) && rawCode >= -255 && rawCode <= 255 ? rawCode : null;
    const signalled = typeof rawSignal === "string" && rawSignal.length > 0;
    let reason: string;
    let to: RunState;
    if (live.stopRequested) [to, reason] = ["CANCELLED", live.stopReason];
    else if (code === 0 && !signalled) [to, reason] = ["REVIEWING", RUN_REASONS.exited];
    else [to, reason] = ["FAILED", signalled ? RUN_REASONS.signalled : code === null ? RUN_REASONS.unknownExit : RUN_REASONS.nonZero];
    if (!live.finalised && live.runId) this.transition(live, to, reason, code);
    void this.afterExit(live, reason, code);
  }

  private async afterExit(live: LiveRun, reason: string, code: number | null): Promise<void> {
    try {
      if (this.closed || !live.runId) return;
      let snapshotAfter = "failed";
      let drift = false;
      const snap = await timed(this.o.clock, this.limits.snapshotTimeoutMs, () =>
        this.o.snapshotter.after({ runId: live.runId as string, workspaceId: live.workspaceId, worktree: live.worktree }),
      );
      if (snap.ok) {
        drift = snap.value?.drift === true;
        snapshotAfter = drift ? "drift" : "ok";
      } else if (snap.why === "timeout") {
        snapshotAfter = "timeout";
      }
      this.audit("daemon", RUN_AUDIT_ACTIONS.exit, `run:${live.runId}`, "success", {
        runId: live.runId, workspaceId: live.workspaceId, state: live.state, reason, exitCode: code, snapshotAfter, drift,
      });
    } catch {
      this.report("afterExit", "E_INTERNAL");
    } finally {
      this.release(live);
    }
  }

  // ---- stop ----

  /** Stop a run: SIGINT, then SIGTERM, then SIGKILL to the process group (PTY-4). Stopping a stopped run is a no-op. */
  stop(runId: string, actor: AuditActor): RunSummary {
    if (!idText.safeParse(runId).success || !actorSchema.safeParse(actor).success) throw new AxisError("E_INVALID_ARGUMENT", "Invalid stop request");
    const live = this.byId.get(runId);
    if (!live || live.phase === "exited") return this.mustSummary(runId);
    if (!live.stopRequested) {
      live.stopRequested = true;
      live.stopReason = RUN_REASONS.userKilled;
      this.audit(actor, RUN_AUDIT_ACTIONS.stop, `run:${runId}`, "success", { runId, workspaceId: live.workspaceId, phase: live.phase });
      if (live.handle && live.phase === "running") {
        live.phase = "stopping";
        this.escalate(live);
      }
    }
    return this.mustSummary(runId);
  }

  private escalate(live: LiveRun): void {
    if (live.escalating || !live.handle) return;
    live.escalating = true;
    const g = this.limits.graceMs;
    this.signal(live, "SIGINT");
    this.after(live, g, () => {
      this.signal(live, "SIGTERM");
      this.after(live, g, () => {
        this.signal(live, "SIGKILL");
        this.after(live, this.limits.killTimeoutMs, () => {
          // No exit event: record the user's intent, keep the slot and the "active" answer until one arrives.
          if (!live.finalised && live.runId) {
            live.finalised = true;
            this.transition(live, "CANCELLED", RUN_REASONS.killUnconfirmed);
          }
          this.report("kill", "E_TIMEOUT");
        });
      });
    });
  }

}
