// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import { summarizeError, type ErrorSummary } from "./log/summarize-error.js";

/**
 * The lifecycle registry (design section 8): every timer, listener and child the host creates is registered here
 * and torn down in reverse order of creation. Timers are `unref`ed, so a leaked one cannot keep the process alive,
 * and the slice test asserts the process exits by draining.
 */

export type DisposeFn = () => void | Promise<void>;

export interface DisposeFailure {
  readonly label: string;
  /** `timeout` when the disposer did not settle in time, otherwise the closed-set summary of what it threw. */
  readonly error: ErrorSummary | "timeout";
}

export interface DisposeResult {
  readonly disposed: number;
  readonly failures: readonly DisposeFailure[];
}

/** The part of an `EventEmitter` that `listen` needs. */
export interface ListenerTarget {
  // `any` so that `EventEmitter` and `process` (whose overloads are typed per event) are assignable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: any, listener: (...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: any, listener: (...args: any[]) => void): unknown;
}

export interface DisposablesOptions {
  /** A disposer that has not settled after this long is abandoned and reported (default 5000; 0 disables). */
  readonly itemTimeoutMs?: number;
}

const LABEL = /^[a-z][a-z0-9._:-]{0,63}$/;
const DEFAULT_ITEM_TIMEOUT_MS = 5_000;
const MAX_ENTRIES = 10_000;

interface Entry {
  readonly label: string;
  readonly fn: DisposeFn;
}

export class Disposables {
  readonly #stack: Entry[] = [];
  readonly #itemTimeoutMs: number;
  #pending: Promise<DisposeResult> | undefined;

  constructor(options: DisposablesOptions = {}) {
    const t = options.itemTimeoutMs ?? DEFAULT_ITEM_TIMEOUT_MS;
    if (!Number.isInteger(t) || t < 0 || t > 600_000) throw new AxisError("E_INVALID_ARGUMENT", "Invalid itemTimeoutMs");
    this.#itemTimeoutMs = t;
  }

  /** Entries not yet disposed. */
  get size(): number {
    return this.#stack.length;
  }

  /** True once `dispose()` was called. */
  get disposed(): boolean {
    return this.#pending !== undefined;
  }

  /**
   * Register a disposer. The returned function runs and unregisters just this one (once). On a registry that is
   * already disposed, the disposer runs immediately, because the caller already created the resource, and the call
   * then throws: something started work after shutdown began.
   */
  add(fn: DisposeFn, label = "anonymous"): () => Promise<void> {
    if (typeof fn !== "function" || !LABEL.test(label)) throw new AxisError("E_INVALID_ARGUMENT", "Invalid disposable");
    if (this.#pending !== undefined) {
      void Promise.resolve()
        .then(fn)
        .catch(() => undefined);
      throw new AxisError("E_INTERNAL", "Disposables are already disposed");
    }
    if (this.#stack.length >= MAX_ENTRIES) {
      void Promise.resolve()
        .then(fn)
        .catch(() => undefined);
      throw new AxisError("E_BACKPRESSURE", "Too many disposables");
    }
    const entry: Entry = { label, fn };
    this.#stack.push(entry);
    return async () => {
      const i = this.#stack.indexOf(entry);
      if (i < 0) return;
      this.#stack.splice(i, 1);
      await fn();
    };
  }

  /** A one-shot timer, `unref`ed and cleared on dispose. */
  setTimeout(fn: () => void, ms: number, label = "timer"): () => Promise<void> {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return this.#track(() => clearTimeout(handle), label, handle);
  }

  /** A repeating timer, `unref`ed and cleared on dispose. */
  setInterval(fn: () => void, ms: number, label = "interval"): () => Promise<void> {
    const handle = setInterval(fn, ms);
    handle.unref();
    return this.#track(() => clearInterval(handle), label, handle);
  }

  /** `target.on(event, listener)`, removed again on dispose. */
  listen<A extends unknown[]>(
    target: ListenerTarget,
    event: string,
    listener: (...args: A) => void,
    label = "listener",
  ): () => Promise<void> {
    target.on(event, listener);
    return this.#track(() => void target.off(event, listener), label);
  }

  #track(undo: () => void, label: string, timer?: NodeJS.Timeout): () => Promise<void> {
    try {
      return this.add(undo, label);
    } catch (e) {
      // `add` already ran `undo` on a disposed registry; make sure a timer cannot outlive the failed call.
      if (timer !== undefined) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      throw e;
    }
  }

  /**
   * Run every disposer, newest first, one at a time. Idempotent: later and concurrent calls get the same result.
   * It never rejects and one failing disposer does not stop the others. Registering while it runs is refused
   * like registering after it (see `add`).
   */
  dispose(): Promise<DisposeResult> {
    this.#pending ??= this.#run();
    return this.#pending;
  }

  async #run(): Promise<DisposeResult> {
    const failures: DisposeFailure[] = [];
    let disposed = 0;
    for (let entry = this.#stack.pop(); entry !== undefined; entry = this.#stack.pop()) {
      const outcome = await this.#runOne(entry.fn);
      if (outcome === "ok") disposed++;
      else failures.push({ label: entry.label, error: outcome });
    }
    return Object.freeze({ disposed, failures: Object.freeze(failures) });
  }

  async #runOne(fn: DisposeFn): Promise<"ok" | ErrorSummary | "timeout"> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const work = Promise.resolve().then(fn);
      if (this.#itemTimeoutMs === 0) {
        await work;
        return "ok";
      }
      const timeout = new Promise<"timeout">((resolve) => {
        // Not unref'ed: while a disposer hangs, this timer is what keeps the process alive to abandon it. It is
        // always cleared below, so it cannot outlive the call.
        timer = setTimeout(() => resolve("timeout"), this.#itemTimeoutMs);
      });
      // The abandoned disposer may still reject later; that must not become an unhandled rejection.
      work.catch(() => undefined);
      return (await Promise.race([work.then(() => "ok" as const), timeout])) as "ok" | "timeout";
    } catch (e) {
      return summarizeError(e);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
