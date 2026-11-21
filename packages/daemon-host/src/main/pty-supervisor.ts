// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-X1b (docs/design/pty-exec-node.md §6.4): main's supervisor of the Axis pty utility process. It restarts a crashed process with
// the daemon supervisor's policy (exponential backoff, at most `maxRestarts` in `windowMs`, then `failed` with `crash_loop`), never
// restarts a process that refused its start (exit 78: a wrong hand-over), and on shutdown sends SIGTERM, then SIGKILL after
// `stopGraceMs`, so the process never outlives main. The pty process has no `ready` message: it serves ports as soon as it runs, so
// "up" is "spawned and not exited", and a run counts as stable `stableMs` after its spawn. Event names are closed strings; nothing
// the child writes reaches them. Electron-free: the seam passes `spawn`, the clock and the timers.
import { DEFAULT_RESTART_POLICY, SUPERVISED_EXIT, type RestartPolicy, type SupervisorTimers } from "../supervisor.js";

/** The process handle the seam gives (an Electron `UtilityProcess` adapter). */
export interface PtyChild {
  /** `SIGTERM` first; `SIGKILL` when the grace ran out. Never throws to the supervisor (failures are caught). */
  kill(signal: "SIGTERM" | "SIGKILL"): unknown;
  onExit(handler: (code: number | null) => void): () => void;
}

export type PtySupervisorState = "idle" | "running" | "backoff" | "stopping" | "stopped" | "failed";
export type PtyFailureReason = "bad_config" | "crash_loop" | "spawn_failed";
export type PtySupervisorEvent = "spawned" | "exited" | "restart_scheduled" | "failed" | "stopping" | "stopped";
export type PtyRestartPolicy = Pick<RestartPolicy, "maxRestarts" | "windowMs" | "baseDelayMs" | "maxDelayMs" | "stableMs" | "stopGraceMs">;

/** The daemon's restart policy; the stop grace is the pty process's own (it has nothing to flush: terminals are killed by group). */
export const DEFAULT_PTY_POLICY: PtyRestartPolicy = Object.freeze({
  maxRestarts: DEFAULT_RESTART_POLICY.maxRestarts,
  windowMs: DEFAULT_RESTART_POLICY.windowMs,
  baseDelayMs: DEFAULT_RESTART_POLICY.baseDelayMs,
  maxDelayMs: DEFAULT_RESTART_POLICY.maxDelayMs,
  stableMs: DEFAULT_RESTART_POLICY.stableMs,
  stopGraceMs: 5_000,
});

export interface PtySupervisorOptions {
  /** Starts the FIXED entry. A throw is `failed` with `spawn_failed`. */
  readonly spawn: () => PtyChild;
  readonly timers: SupervisorTimers;
  /** Monotonic milliseconds. */
  readonly now: () => number;
  readonly policy?: Partial<PtyRestartPolicy>;
  readonly onEvent?: (event: PtySupervisorEvent, fields: { readonly code?: number | null; readonly reason?: PtyFailureReason; readonly count?: number }) => void;
  /** Each (re)spawned child, and its exit: the control hand-over follows these. */
  readonly onChild?: (child: PtyChild, alive: boolean) => void;
}

export class PtySupervisor {
  readonly #o: PtySupervisorOptions;
  readonly #policy: PtyRestartPolicy;
  #state: PtySupervisorState = "idle";
  #failure: PtyFailureReason | undefined;
  #child: PtyChild | undefined;
  #off: (() => void) | undefined;
  #generation = 0;
  #spawnedAt = 0;
  #crashes: number[] = [];
  #backoffTimer: unknown;
  #stopTimer: unknown;
  #stopWaiters: (() => void)[] = [];

  constructor(options: PtySupervisorOptions) {
    this.#o = options;
    this.#policy = { ...DEFAULT_PTY_POLICY, ...options.policy };
  }

  state(): PtySupervisorState {
    return this.#state;
  }

  failure(): PtyFailureReason | undefined {
    return this.#failure;
  }

  start(): void {
    if (this.#state === "idle") this.#spawn();
  }

  /** SIGTERM, then SIGKILL after `stopGraceMs`; resolves when the child is gone or the kill was sent. Cancels a pending restart. */
  shutdown(): Promise<void> {
    if (this.#state === "stopped" || this.#state === "failed" || this.#state === "idle") {
      if (this.#state !== "failed") this.#state = "stopped";
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#stopWaiters.push(resolve);
      if (this.#state === "stopping") return;
      this.#state = "stopping";
      this.#emit("stopping", {});
      this.#clearTimers();
      const child = this.#child;
      if (child === undefined) return this.#finishStop();
      this.#kill(child, "SIGTERM");
      this.#stopTimer = this.#o.timers.set(() => {
        this.#stopTimer = undefined;
        // A child that does not report its exit after SIGKILL must not hold the app open: the stop is over.
        this.#kill(child, "SIGKILL");
        this.#detach(child);
        this.#finishStop();
      }, this.#policy.stopGraceMs);
    });
  }

  #spawn(): void {
    const generation = ++this.#generation;
    let child: PtyChild;
    try {
      child = this.#o.spawn();
    } catch {
      return this.#fail("spawn_failed");
    }
    this.#child = child;
    this.#spawnedAt = this.#o.now();
    this.#state = "running";
    this.#off = child.onExit((code) => this.#onExit(code, generation));
    this.#emit("spawned", {});
    this.#notify(child, true);
  }

  #onExit(code: number | null, generation: number): void {
    if (generation !== this.#generation) return;
    const child = this.#child;
    if (child !== undefined) this.#detach(child);
    this.#emit("exited", { code });
    if (this.#state === "stopping") {
      if (this.#stopTimer !== undefined) this.#o.timers.clear(this.#stopTimer);
      this.#stopTimer = undefined;
      return this.#finishStop();
    }
    if (code === SUPERVISED_EXIT.BAD_CONFIG) return this.#fail("bad_config");
    const now = this.#o.now();
    if (now - this.#spawnedAt >= this.#policy.stableMs) this.#crashes = [];
    this.#crashes = this.#crashes.filter((t) => now - t < this.#policy.windowMs);
    this.#crashes.push(now);
    if (this.#crashes.length > this.#policy.maxRestarts) return this.#fail("crash_loop");
    const delay = Math.min(this.#policy.maxDelayMs, this.#policy.baseDelayMs * 2 ** (this.#crashes.length - 1));
    this.#state = "backoff";
    this.#emit("restart_scheduled", { code, count: this.#crashes.length });
    // Every way out of backoff (shutdown, failure) clears this timer, so it fires only in backoff.
    this.#backoffTimer = this.#o.timers.set(() => {
      this.#backoffTimer = undefined;
      this.#spawn();
    }, delay);
  }

  #detach(child: PtyChild): void {
    if (this.#child !== child) return;
    this.#off?.();
    this.#off = undefined;
    this.#child = undefined;
    this.#generation++;
    this.#notify(child, false);
  }

  #fail(reason: PtyFailureReason): void {
    this.#failure = reason;
    this.#clearTimers();
    this.#state = "failed";
    this.#emit("failed", { reason });
  }

  #finishStop(): void {
    this.#clearTimers();
    this.#state = "stopped";
    this.#emit("stopped", {});
    for (const resolve of this.#stopWaiters.splice(0)) resolve();
  }

  #kill(child: PtyChild, signal: "SIGTERM" | "SIGKILL"): void {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }

  #clearTimers(): void {
    for (const t of [this.#backoffTimer, this.#stopTimer]) if (t !== undefined) this.#o.timers.clear(t);
    this.#backoffTimer = this.#stopTimer = undefined;
  }

  #notify(child: PtyChild, alive: boolean): void {
    try {
      this.#o.onChild?.(child, alive);
    } catch {
      // an observer never changes the state machine
    }
  }

  #emit(event: PtySupervisorEvent, fields: { code?: number | null; reason?: PtyFailureReason; count?: number }): void {
    try {
      this.#o.onEvent?.(event, fields);
    } catch {
      // as above
    }
  }
}

/**
 * Shutdown order (§6.4): the daemon first, then the pty process. The daemon's stop is awaited for at most `daemonBoundMs`, so a
 * daemon whose shutdown never settles cannot keep the pty process (and its terminal groups) alive: the pty stop starts at the bound.
 */
export async function shutdownInOrder(daemonStop: () => Promise<void>, pty: Pick<PtySupervisor, "shutdown">, timers: SupervisorTimers, daemonBoundMs: number): Promise<void> {
  let handle: unknown;
  const bound = new Promise<void>((resolve) => {
    handle = timers.set(resolve, daemonBoundMs);
  });
  try {
    await Promise.race([daemonStop().catch(() => undefined), bound]);
  } finally {
    timers.clear(handle);
  }
  await pty.shutdown();
}
