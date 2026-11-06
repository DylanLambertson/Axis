// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * `native.confirm` (ticket X1c, `docs/design/main-answers.md` section 3.2): one modal dialog at a time, on the window the
 * request names, answered `native.result` with the request's own proof. A window that is gone or never connected, an entry that
 * waited past the challenge's lifetime, a full queue and a dialog that throws are all `confirmed: false`. A second request for a
 * challenge that is already waiting is ignored. `dispose` answers nothing more. The proof is held only until the answer is sent.
 */

export interface NativeDialogPort {
  /** Show the dialog modal on the code window; `true` only for the confirm button. */
  confirm(request: { readonly codeWindowId: number; readonly summary: string }): Promise<boolean>;
}

export interface NativeRequest {
  readonly challengeId: string;
  readonly proof: string;
  readonly windowId: string;
  readonly summary: string;
}

export const NATIVE_REFUSALS = ["no_window", "expired", "queue_full", "dialog_failed"] as const;
export type NativeRefusal = (typeof NATIVE_REFUSALS)[number];

export interface NativeQueueOptions {
  readonly dialog: NativeDialogPort;
  readonly codeWindowOf: (windowId: string) => number | undefined;
  /** Monotonic milliseconds. */
  readonly now: () => number;
  readonly ttlMs?: number;
  readonly maxWaiting?: number;
  readonly onRefused?: (reason: NativeRefusal) => void;
}

interface Entry {
  readonly request: NativeRequest;
  readonly at: number;
  readonly reply: (message: unknown) => void;
}

export const DEFAULT_NATIVE_TTL_MS = 60_000;
export const DEFAULT_NATIVE_WAITING = 16;

export class NativeQueue {
  readonly #o: NativeQueueOptions;
  readonly #ttl: number;
  readonly #max: number;
  readonly #waiting: Entry[] = [];
  #open: Entry | undefined;
  #disposed = false;

  constructor(options: NativeQueueOptions) {
    this.#o = options;
    this.#ttl = options.ttlMs ?? DEFAULT_NATIVE_TTL_MS;
    this.#max = options.maxWaiting ?? DEFAULT_NATIVE_WAITING;
  }

  get size(): number {
    return this.#waiting.length + (this.#open === undefined ? 0 : 1);
  }

  push(request: NativeRequest, reply: (message: unknown) => void): void {
    if (this.#disposed) return;
    const id = request.challengeId;
    if (this.#open?.request.challengeId === id || this.#waiting.some((e) => e.request.challengeId === id)) return;
    const entry: Entry = { request, at: this.#o.now(), reply };
    if (this.size >= this.#max) return this.#answer(entry, false, "queue_full");
    this.#waiting.push(entry);
    this.#pump();
  }

  dispose(): void {
    this.#disposed = true;
    this.#waiting.length = 0;
    this.#open = undefined;
  }

  #pump(): void {
    while (!this.#disposed && this.#open === undefined && this.#waiting.length > 0) {
      const entry = this.#waiting.shift() as Entry;
      if (this.#o.now() - entry.at > this.#ttl) {
        this.#answer(entry, false, "expired");
        continue;
      }
      let codeWindowId: number | undefined;
      try {
        codeWindowId = this.#o.codeWindowOf(entry.request.windowId);
      } catch {
        codeWindowId = undefined;
      }
      if (codeWindowId === undefined) {
        this.#answer(entry, false, "no_window");
        continue;
      }
      this.#open = entry;
      let shown: Promise<boolean>;
      try {
        shown = Promise.resolve(this.#o.dialog.confirm({ codeWindowId, summary: entry.request.summary }));
      } catch (e) {
        shown = Promise.reject(e);
      }
      shown.then(
        (v) => this.#close(entry, v === true, undefined),
        () => this.#close(entry, false, "dialog_failed"),
      );
    }
  }

  #close(entry: Entry, confirmed: boolean, reason: NativeRefusal | undefined): void {
    if (this.#open !== entry) return; // disposed meanwhile
    this.#open = undefined;
    this.#answer(entry, confirmed, reason);
    this.#pump();
  }

  #answer(entry: Entry, confirmed: boolean, reason: NativeRefusal | undefined): void {
    if (this.#disposed) return;
    if (reason !== undefined) {
      try {
        this.#o.onRefused?.(reason);
      } catch {
        // an observer never changes the answer
      }
    }
    const { challengeId, proof, windowId } = entry.request;
    try {
      entry.reply({ type: "native.result", challengeId, proof, confirmed, windowId });
    } catch {
      // a closed channel: the host times out, which is a refusal
    }
  }
}
