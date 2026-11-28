// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The subset of Code OSS's `vs/base/common/event` the ported modules use (OS-5): an `Event<T>` is a function that
// subscribes a listener and returns its disposable; an `Emitter<T>` owns one. A listener that throws does not stop the
// others; its error is reported through the unexpected-error handler, once per throw. As in Code OSS, the leak tracker
// counts an emitter's subscriptions, not the emitter itself.
import { DisposableStore, toDisposable, type IDisposable } from "./lifecycle.js";

export type Event<T> = (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: IDisposable[] | DisposableStore) => IDisposable;

let unexpected: (error: unknown) => void = (error) => {
  queueMicrotask(() => {
    throw error;
  });
};

/** Where a throwing listener's error goes (tests capture it). Returns the previous handler. */
export function setUnexpectedErrorHandler(handler: (error: unknown) => void): (error: unknown) => void {
  const previous = unexpected;
  unexpected = handler;
  return previous;
}

export namespace Event {
  /** An event that never fires. */
  export const None: Event<never> = () => toDisposable(() => {});
}

interface Listener<T> {
  readonly fn: (e: T) => unknown;
  readonly thisArgs: unknown;
  /** False once its subscription or the emitter is disposed: a pending delivery skips it. */
  live: boolean;
}

/** One fire in progress: the listeners subscribed when it began, and how far delivery has got. */
interface Delivery<T> {
  readonly event: T;
  readonly listeners: readonly Listener<T>[];
  next: number;
}

/**
 * Delivery follows the pinned Code OSS emitter (2c33b50b, `vs/base/common/event.ts`):
 * - a fire reaches the listeners subscribed when it began, in subscription order; one added during delivery waits for
 *   the next fire;
 * - a listener whose subscription is disposed during delivery, by an earlier listener or itself, is not called again,
 *   and disposing the emitter during delivery stops the rest of that delivery;
 * - a fire from inside a listener first finishes the delivery in progress, then delivers its own event, so every
 *   listener sees the events in the order they were fired (a status listener never ends on a stale status).
 */
export class Emitter<T> implements IDisposable {
  #listeners: Listener<T>[] = [];
  #delivery: Delivery<T> | undefined;
  #disposed = false;
  #event: Event<T> | undefined;

  get event(): Event<T> {
    this.#event ??= (fn, thisArgs, disposables) => {
      if (this.#disposed) return toDisposable(() => {});
      const entry: Listener<T> = { fn, thisArgs, live: true };
      this.#listeners.push(entry);
      const sub = toDisposable(() => {
        entry.live = false;
        const at = this.#listeners.indexOf(entry);
        if (at !== -1) this.#listeners.splice(at, 1);
      });
      if (disposables instanceof DisposableStore) disposables.add(sub);
      else if (Array.isArray(disposables)) disposables.push(sub);
      return sub;
    };
    return this.#event;
  }

  hasListeners(): boolean {
    return this.#listeners.length > 0;
  }

  fire(e: T): void {
    if (this.#disposed) return;
    // A fire from inside a listener: finish the delivery in progress first (the Code OSS delivery queue).
    if (this.#delivery !== undefined) this.#drain(this.#delivery);
    if (this.#disposed) return;
    const delivery: Delivery<T> = { event: e, listeners: [...this.#listeners], next: 0 };
    this.#delivery = delivery;
    this.#drain(delivery);
  }

  #drain(delivery: Delivery<T>): void {
    while (this.#delivery === delivery && delivery.next < delivery.listeners.length) {
      const l = delivery.listeners[delivery.next++]!;
      if (!l.live) continue;
      try {
        l.fn.call(l.thisArgs, delivery.event);
      } catch (error) {
        unexpected(error);
      }
    }
    if (this.#delivery === delivery) this.#delivery = undefined;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const l of this.#listeners) l.live = false;
    this.#listeners = [];
    this.#delivery = undefined;
  }
}
