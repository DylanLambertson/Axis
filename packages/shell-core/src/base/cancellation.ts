// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The subset of Code OSS's `vs/base/common/cancellation` the ported modules use (OS-5).
import { Emitter, Event } from "./event.js";
import { toDisposable, type IDisposable } from "./lifecycle.js";

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  /** Fires once, on cancellation. A listener added after cancellation is called at once (on a microtask). */
  readonly onCancellationRequested: Event<void>;
}

const shortcut: Event<void> = (fn, thisArgs) => {
  const handle = setTimeout(() => fn.call(thisArgs, undefined), 0);
  return toDisposable(() => clearTimeout(handle));
};

export namespace CancellationToken {
  export const None: CancellationToken = Object.freeze({ isCancellationRequested: false, onCancellationRequested: Event.None });
  export const Cancelled: CancellationToken = Object.freeze({ isCancellationRequested: true, onCancellationRequested: shortcut });
}

class MutableToken implements CancellationToken, IDisposable {
  #cancelled = false;
  #emitter: Emitter<void> | undefined;

  get isCancellationRequested(): boolean {
    return this.#cancelled;
  }

  get onCancellationRequested(): Event<void> {
    if (this.#cancelled) return shortcut;
    this.#emitter ??= new Emitter<void>();
    return this.#emitter.event;
  }

  cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#emitter?.fire(undefined);
    this.dispose();
  }

  dispose(): void {
    this.#emitter?.dispose();
    this.#emitter = undefined;
  }
}

export class CancellationTokenSource implements IDisposable {
  #token: MutableToken | CancellationToken | undefined;

  get token(): CancellationToken {
    this.#token ??= new MutableToken();
    return this.#token;
  }

  cancel(): void {
    if (this.#token === undefined) this.#token = CancellationToken.Cancelled;
    else if (this.#token instanceof MutableToken) this.#token.cancel();
  }

  /** `cancel` true cancels first. A disposed source's token never fires. */
  dispose(cancel = false): void {
    if (cancel) this.cancel();
    if (this.#token instanceof MutableToken) this.#token.dispose();
    else if (this.#token === undefined) this.#token = CancellationToken.None;
  }
}
