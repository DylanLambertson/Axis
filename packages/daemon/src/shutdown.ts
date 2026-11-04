// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { DrainGate } from "./drain.js";
import type { IdempotencyStore } from "./types.js";

export interface ShutdownOptions {
  /** How long in-flight handlers may keep running before they are cancelled. Default 10 000 ms. */
  readonly graceMs?: number;
  /** How long cancelled handlers may take to settle before the connections are closed anyway. Default 2 000 ms. */
  readonly cancelSettleMs?: number;
  /** How long the idempotency flush may take. Default 5 000 ms. */
  readonly flushTimeoutMs?: number;
}

export interface ShutdownResult {
  /** Why shutdown started (first caller wins; truncated). */
  readonly reason: string;
  /** Every handler settled without being cancelled. */
  readonly graceful: boolean;
  /** The second signal (or `escalate()`) cut a wait short. */
  readonly escalated: boolean;
  /** Requests cancelled when the grace period ended. */
  readonly cancelled: number;
  /** Handlers still running when the daemon gave up waiting: they keep their slots and orphan counts. */
  readonly unsettled: number;
  /** `unsupported`: the store has no `flush`. */
  readonly flushed: "done" | "unsupported" | "failed";
}

/** An idempotency store may offer `flush`; the in-memory store has nothing to write, the journal-backed one may. */
export type FlushableIdempotencyStore = IdempotencyStore & { flush?(): void | Promise<void> };

/** What the coordinator needs from the daemon. */
export interface ShutdownTarget {
  readonly drain: DrainGate;
  /** Cancel every unanswered request through the normal cancel path; returns how many. */
  cancelAll(): number;
  /** The existing `stop()`: abort what is left and close every connection. */
  closeAll(): void;
  readonly store: FlushableIdempotencyStore;
  readonly onError: (where: string, error: unknown) => void;
}

const REASON_MAX = 64;
const DEFAULTS = { graceMs: 10_000, cancelSettleMs: 2_000, flushTimeoutMs: 5_000 };

/**
 * Graceful shutdown: refuse new work, let handlers settle for `graceMs`, cancel
 * what remains, wait briefly for it to settle, close, flush. Idempotent: every
 * `run` returns the same promise, which never rejects. `escalate()` skips the
 * wait in progress. It leaves no timer or listener behind.
 */
export class ShutdownCoordinator {
  readonly #t: ShutdownTarget;
  readonly #o: Required<ShutdownOptions>;
  #result: Promise<ShutdownResult> | undefined;
  #escalated = false;
  #wake: (() => void) | undefined;

  constructor(target: ShutdownTarget, options: ShutdownOptions = {}) {
    this.#t = target;
    this.#o = { ...DEFAULTS, ...options };
  }

  get started(): boolean {
    return this.#result !== undefined;
  }

  run(reason: string): Promise<ShutdownResult> {
    this.#result ??= this.#run(typeof reason === "string" ? reason.slice(0, REASON_MAX) : "unspecified");
    return this.#result;
  }

  /** Skip the wait in progress (grace, or the settle after cancel). No effect before `run`. */
  escalate(): void {
    if (!this.#result) return;
    this.#escalated = true;
    this.#wake?.();
  }

  /** Resolves true when nothing is running any more, false on timeout or escalation. */
  #settled(ms: number): Promise<boolean> {
    const drain = this.#t.drain;
    if (drain.running === 0) return Promise.resolve(true);
    if (this.#escalated) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let done = false;
      let off: () => void = () => undefined;
      const timer: NodeJS.Timeout = setTimeout(() => finish(false), Math.max(0, ms));
      const finish = (idle: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        this.#wake = undefined;
        resolve(idle);
      };
      off = drain.onIdle(() => finish(true));
      this.#wake = () => finish(false);
    });
  }

  async #run(reason: string): Promise<ShutdownResult> {
    const t = this.#t;
    let cancelled = 0;
    try {
      t.drain.begin();
      let graceful = await this.#settled(this.#o.graceMs);
      if (!graceful) {
        cancelled = t.cancelAll();
        await this.#settled(this.#o.cancelSettleMs);
      }
      graceful = graceful && cancelled === 0;
      t.closeAll();
      const flushed = await this.#flush();
      return { reason, graceful, escalated: this.#escalated, cancelled, unsettled: t.drain.running, flushed };
    } catch (error) {
      // Unreachable by design (the steps above report their own failures); never reject.
      t.onError("shutdown", error);
      try {
        t.closeAll();
      } catch {
        // already closed
      }
      return { reason, graceful: false, escalated: this.#escalated, cancelled, unsettled: t.drain.running, flushed: "failed" };
    }
  }

  async #flush(): Promise<ShutdownResult["flushed"]> {
    const store = this.#t.store;
    if (typeof store.flush !== "function") return "unsupported";
    let timer: NodeJS.Timeout | undefined;
    try {
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), this.#o.flushTimeoutMs);
      });
      const outcome = await Promise.race([Promise.resolve().then(() => store.flush?.()).then(() => "done" as const), timedOut]);
      if (outcome === "timeout") {
        this.#t.onError("shutdown-flush", new Error("idempotency flush timed out"));
        return "failed";
      }
      return "done";
    } catch (error) {
      this.#t.onError("shutdown-flush", error);
      return "failed";
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
