// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * Counts handlers still running after their caller was told about a timeout,
 * a cancel or a close. The count is charged to the originating window, which
 * is stable across reconnects, so one window's misbehaviour fills its own
 * quota and nobody else's. The daemon-wide cap is only a larger backstop.
 */
export class OrphanTracker {
  #total = 0;
  readonly #byWindow = new Map<string, number>();
  constructor(
    /** Daemon-wide backstop. */
    readonly max: number,
    /** Per window. */
    readonly maxPerWindow: number,
  ) {}
  get count(): number {
    return this.#total;
  }
  countFor(windowId: string): number {
    return this.#byWindow.get(windowId) ?? 0;
  }
  /** Why a new request from this window must be refused, if it must. */
  refusal(windowId: string): "window" | "daemon" | undefined {
    if (this.countFor(windowId) >= this.maxPerWindow) return "window";
    return this.#total >= this.max ? "daemon" : undefined;
  }
  add(windowId: string): void {
    this.#total++;
    this.#byWindow.set(windowId, this.countFor(windowId) + 1);
  }
  remove(windowId: string): void {
    this.#total--;
    const n = this.countFor(windowId) - 1;
    if (n <= 0) this.#byWindow.delete(windowId);
    else this.#byWindow.set(windowId, n);
  }
}
