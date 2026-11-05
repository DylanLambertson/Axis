// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { ProviderError } from "./errors.js";
import type { Timers } from "./guard-types.js";

export type AbortWhy = "cancelled" | "timeout_idle" | "timeout_request";

export function abortError(why: AbortWhy): ProviderError {
  if (why === "cancelled") return new ProviderError("cancelled");
  return new ProviderError("timeout", { reason: why === "timeout_idle" ? "idle" : "request" });
}

/** One request's abort plumbing: the caller's signal plus our timeouts. */
export class RequestControl {
  readonly controller = new AbortController();
  why: AbortWhy | undefined;
  /** Rejecters of the calls `race` is waiting on; each is removed as soon as its call settles. */
  private readonly pending = new Set<(e: unknown) => void>();
  private idleHandle: unknown;
  private readonly requestHandle: unknown;
  private readonly listeners: Array<() => void> = [];
  private readonly onCallerAbort = (): void => this.abort("cancelled");

  constructor(
    private readonly callerSignal: AbortSignal,
    private readonly timers: Timers,
    private readonly idleMs: number,
    requestMs: number,
  ) {
    callerSignal.addEventListener("abort", this.onCallerAbort, { once: true });
    this.requestHandle = timers.setTimeout(() => this.abort("timeout_request"), requestMs);
    if (callerSignal.aborted) this.abort("cancelled");
  }

  /** Start (or restart) the idle timer: we are now waiting on the provider. */
  touch(): void {
    this.pause();
    if (this.why === undefined) this.idleHandle = this.timers.setTimeout(() => this.abort("timeout_idle"), this.idleMs);
  }

  /** Stop the idle timer: the consumer, not the provider, has the turn (S2). */
  pause(): void {
    if (this.idleHandle !== undefined) this.timers.clearTimeout(this.idleHandle);
    this.idleHandle = undefined;
  }

  onAbort(fn: () => void): void {
    this.listeners.push(fn);
  }

  abort(why: AbortWhy): void {
    if (this.why !== undefined) return;
    this.why = why;
    this.controller.abort();
    for (const reject of [...this.pending]) reject(abortError(why));
    this.pending.clear();
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // A listener failure must not stop the abort.
      }
    }
  }

  /**
   * Settle with `p`, or fail as soon as the request is aborted, whichever is
   * first. Not `Promise.race` against one abort promise that lives as long as
   * the stream: every race would add a reaction to it, keeping each settled
   * step alive until the stream ends (about 430 bytes per event; review of
   * guard.ts:228). Each call registers its own rejecter and removes it when
   * `p` settles, so nothing accumulates.
   */
  race<T>(p: Promise<T>): Promise<T> {
    const why = this.why;
    if (why !== undefined) {
      p.catch(() => undefined);
      return Promise.reject(abortError(why));
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.add(reject);
      p.then(
        (v) => {
          this.pending.delete(reject);
          resolve(v);
        },
        (e: unknown) => {
          this.pending.delete(reject);
          reject(e);
        },
      );
    });
  }

  dispose(): void {
    this.callerSignal.removeEventListener("abort", this.onCallerAbort);
    this.timers.clearTimeout(this.requestHandle);
    this.pause();
  }
}
