// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { DrainGate } from "./drain.js";
import type { IdempotencyStore } from "./types.js";

export interface ShutdownOptions {
  /**
   * All three: milliseconds. `undefined` keeps the default, `Infinity` waits without a timer (until the work
   * ends or `escalate()`), a finite value above 2^31-1 is clamped to it, and NaN, a negative number or a
   * non-number throws a TypeError from the constructor.
   *
   * How long in-flight handlers may keep running before they are cancelled. Default 10 000 ms. */
  readonly graceMs?: number | undefined;
  /** How long cancelled handlers may take to settle before the connections are closed anyway. Default 2 000 ms. */
  readonly cancelSettleMs?: number | undefined;
  /** How long the idempotency flush may take. Default 5 000 ms. */
  readonly flushTimeoutMs?: number | undefined;
}

export interface ShutdownResult {
  /** Why shutdown started (first caller wins; truncated). */
  readonly reason: string;
  /** Every handler settled without being cancelled. */
  readonly graceful: boolean;
  /** `escalate()` (a repeated signal) cut at least one wait short. */
  readonly escalated: boolean;
  /** Requests cancelled when the grace period ended. */
  readonly cancelled: number;
  /** Handlers still running when the daemon gave up waiting: they keep their slots and orphan counts. */
  readonly unsettled: number;
  /**
   * `unsupported`: the store has no `flush`. `failed`: it threw. `running`: it was cut short (timeout or
   * escalation) and had not settled, so it may still be writing: do not close the store until it has.
   */
  readonly flushed: "done" | "unsupported" | "failed" | "running";
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
const MAX_TIMER_MS = 2_147_483_647;
const DEFAULTS = { graceMs: 10_000, cancelSettleMs: 2_000, flushTimeoutMs: 5_000 };

function timing(name: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) throw new TypeError(`shutdown.${name} must be a number >= 0 (or Infinity)`);
  return value === Infinity ? Infinity : Math.min(value, MAX_TIMER_MS);
}

/** A timer for a finite wait; none for Infinity. */
function arm(ms: number, fn: () => void): NodeJS.Timeout | undefined {
  return Number.isFinite(ms) ? (setTimeout(fn, ms) as unknown as NodeJS.Timeout) : undefined; // opaque handle under Code OSS's typings (ADR 0005)
}

/**
 * Graceful shutdown: refuse new work, let handlers settle for `graceMs`, cancel
 * what remains, wait briefly for it to settle, close, flush. Idempotent: every
 * `run` returns the same promise, which never rejects. `escalate()` skips the
 * wait in progress (grace, settle after cancel, or flush) and only that one: each
 * further call skips the next. It leaves no timer or listener behind.
 */
export class ShutdownCoordinator {
  readonly #t: ShutdownTarget;
  readonly #o: { readonly graceMs: number; readonly cancelSettleMs: number; readonly flushTimeoutMs: number };
  #result: Promise<ShutdownResult> | undefined;
  #escalated = false;
  #wake: (() => void) | undefined;

  constructor(target: ShutdownTarget, options: ShutdownOptions = {}) {
    this.#t = target;
    this.#o = {
      graceMs: timing("graceMs", options.graceMs, DEFAULTS.graceMs),
      cancelSettleMs: timing("cancelSettleMs", options.cancelSettleMs, DEFAULTS.cancelSettleMs),
      flushTimeoutMs: timing("flushTimeoutMs", options.flushTimeoutMs, DEFAULTS.flushTimeoutMs),
    };
  }

  get started(): boolean {
    return this.#result !== undefined;
  }

  run(reason: string): Promise<ShutdownResult> {
    this.#result ??= this.#run(typeof reason === "string" ? reason.slice(0, REASON_MAX) : "unspecified");
    return this.#result;
  }

  /** Skip the wait in progress. No effect before `run`, between waits, or after the end. */
  escalate(): void {
    if (!this.#result || !this.#wake) return;
    this.#escalated = true;
    this.#wake();
  }

  /** Resolves true when nothing is running any more, false on timeout or escalation. */
  #settled(ms: number): Promise<boolean> {
    const drain = this.#t.drain;
    if (drain.running === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let done = false;
      let off: () => void = () => undefined;
      let timer: NodeJS.Timeout | undefined;
      const finish = (idle: boolean): void => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        off();
        this.#wake = undefined;
        resolve(idle);
      };
      timer = arm(ms, () => finish(false));
      off = drain.onIdle(() => finish(true));
      this.#wake = () => finish(false);
    });
  }

  async #run(reason: string): Promise<ShutdownResult> {
    const t = this.#t;
    let cancelled = 0;
    try {
      t.drain.begin();
      const graceful = await this.#settled(this.#o.graceMs);
      if (!graceful) {
        cancelled = t.cancelAll();
        // Only requests that were still unanswered have anything new to react to.
        if (cancelled > 0) await this.#settled(this.#o.cancelSettleMs);
      }
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
      const cutShort = new Promise<"cut">((resolve) => {
        timer = arm(this.#o.flushTimeoutMs, () => resolve("cut"));
        this.#wake = () => resolve("cut");
      });
      let settled = false;
      const flushing = Promise.resolve()
        .then(() => store.flush?.())
        .then(() => "done" as const)
        .finally(() => void (settled = true));
      flushing.catch(() => undefined); // a failure after being cut short is not an unhandled rejection
      const outcome = await Promise.race([flushing, cutShort]);
      if (outcome === "cut") {
        this.#t.onError("shutdown-flush", new Error("idempotency flush timed out or was cut short"));
        return settled ? "failed" : "running";
      }
      return "done";
    } catch (error) {
      this.#t.onError("shutdown-flush", error);
      return "failed";
    } finally {
      this.#wake = undefined;
      if (timer) clearTimeout(timer);
    }
  }
}
