// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The per-project mutex of design section 7.2 (lock order is always: this project mutex, then the manager's own
 * workspace lock). It is re-entrant for the call chain that already holds it, because the approval pipeline runs
 * the handler INSIDE a content hook's `withLock` and the handler's own work takes the same project: a plain mutex
 * would deadlock there. Reentrancy follows the async call chain (`AsyncLocalStorage`), so an unrelated request
 * never slips in, and it is per key, so two projects never block each other.
 *
 * Waiters are served in order. A waiter whose `signal` aborts while it waits gives up without running. The map holds
 * an entry only while a call is queued or running.
 */
export class ProjectMutex {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #held = new AsyncLocalStorage<ReadonlySet<string>>();

  /** Keys with a call queued or running (for tests and stats). */
  get size(): number {
    return this.#tails.size;
  }

  async run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const held = this.#held.getStore();
    if (held?.has(key) === true) return fn();
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => mine);
    this.#tails.set(key, tail);
    try {
      await previous;
      signal?.throwIfAborted();
      return await this.#held.run(new Set([...(held ?? []), key]), fn);
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}
