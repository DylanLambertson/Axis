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

export class Emitter<T> implements IDisposable {
  #listeners: Array<{ fn: (e: T) => unknown; thisArgs: unknown }> = [];
  #disposed = false;
  #event: Event<T> | undefined;

  get event(): Event<T> {
    this.#event ??= (fn, thisArgs, disposables) => {
      if (this.#disposed) return toDisposable(() => {});
      const entry = { fn, thisArgs };
      this.#listeners = [...this.#listeners, entry];
      const sub = toDisposable(() => {
        this.#listeners = this.#listeners.filter((l) => l !== entry);
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

  /** Calls every listener subscribed when the fire began, in subscription order. */
  fire(e: T): void {
    if (this.#disposed) return;
    for (const l of this.#listeners) {
      try {
        l.fn.call(l.thisArgs, e);
      } catch (error) {
        unexpected(error);
      }
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners = [];
  }
}
