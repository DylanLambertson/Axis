// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The subset of Code OSS's `vs/base/common/async` the ported modules and tests use (OS-5).

/** A promise settled from outside. */
export class DeferredPromise<T> {
  readonly p: Promise<T>;
  #resolve!: (value: T) => void;
  #reject!: (error: unknown) => void;
  #settled = false;

  constructor() {
    this.p = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  get isSettled(): boolean {
    return this.#settled;
  }

  complete(value: T): Promise<void> {
    this.#settled = true;
    this.#resolve(value);
    return this.p.then(() => undefined, () => undefined);
  }

  error(error: unknown): Promise<void> {
    this.#settled = true;
    this.#reject(error);
    return this.p.then(() => undefined, () => undefined);
  }
}
