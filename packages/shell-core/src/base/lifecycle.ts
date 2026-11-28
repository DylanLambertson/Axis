// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The subset of Code OSS's `vs/base/common/lifecycle` the ported modules use (OS-5), with a leak tracker for tests
// (the replacement of `ensureNoDisposablesAreLeakedInTestSuite`).

export interface IDisposable {
  dispose(): void;
}

/** Tracks live disposables while a test installs it; `undefined` (the default) tracks nothing. */
export interface DisposableTracker {
  created(d: IDisposable): void;
  disposed(d: IDisposable): void;
}

let tracker: DisposableTracker | undefined;

export function setDisposableTracker(t: DisposableTracker | undefined): void {
  tracker = t;
}

export function trackCreated(d: IDisposable): void {
  tracker?.created(d);
}

export function trackDisposed(d: IDisposable): void {
  tracker?.disposed(d);
}

class FunctionDisposable implements IDisposable {
  #fn: (() => void) | undefined;
  constructor(fn: () => void) {
    this.#fn = fn;
    trackCreated(this);
  }
  dispose(): void {
    const fn = this.#fn;
    if (fn === undefined) return;
    this.#fn = undefined;
    trackDisposed(this);
    fn();
  }
}

/** A disposable that runs `fn` once, on its first dispose. */
export function toDisposable(fn: () => void): IDisposable {
  return new FunctionDisposable(fn);
}

/** Disposes every item; the first error is rethrown after all of them ran. */
export function dispose(items: Iterable<IDisposable>): void {
  let first: { error: unknown } | undefined;
  for (const d of items) {
    try {
      d.dispose();
    } catch (error) {
      first ??= { error };
    }
  }
  if (first !== undefined) throw first.error;
}

/** A set of disposables disposed together. Adding to a disposed store disposes the item at once. */
export class DisposableStore implements IDisposable {
  readonly #items = new Set<IDisposable>();
  #disposed = false;

  constructor() {
    trackCreated(this);
  }

  get isDisposed(): boolean {
    return this.#disposed;
  }

  add<T extends IDisposable>(d: T): T {
    if ((d as unknown) === this) throw new Error("a store cannot hold itself");
    if (this.#disposed) d.dispose();
    else this.#items.add(d);
    return d;
  }

  /** Disposes the items now and keeps the store usable. */
  clear(): void {
    const items = [...this.#items];
    this.#items.clear();
    dispose(items);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    trackDisposed(this);
    this.clear();
  }
}

/** Holds at most one disposable; setting another disposes the previous one. */
export class MutableDisposable<T extends IDisposable> implements IDisposable {
  #value: T | undefined;
  #disposed = false;

  constructor() {
    trackCreated(this);
  }

  get value(): T | undefined {
    return this.#disposed ? undefined : this.#value;
  }

  set value(next: T | undefined) {
    if (this.#disposed || next === this.#value) {
      if (this.#disposed) next?.dispose();
      return;
    }
    const old = this.#value;
    this.#value = next;
    old?.dispose();
  }

  clear(): void {
    this.value = undefined;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    trackDisposed(this);
    const old = this.#value;
    this.#value = undefined;
    old?.dispose();
  }
}

/** A base class whose `_register`ed disposables go with it. */
export abstract class Disposable implements IDisposable {
  protected readonly _store = new DisposableStore();

  constructor() {
    trackCreated(this);
  }

  protected _register<T extends IDisposable>(d: T): T {
    if ((d as unknown) === this) throw new Error("a disposable cannot register itself");
    return this._store.add(d);
  }

  dispose(): void {
    trackDisposed(this);
    this._store.dispose();
  }
}
