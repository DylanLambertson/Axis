// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * Daemon-wide count of handlers still running after their caller was told
 * about a timeout, a cancel or a close. New requests are refused with
 * E_BACKPRESSURE above `max`, so a reconnect loop cannot multiply work that
 * will not stop.
 */
export class OrphanTracker {
  #count = 0;
  constructor(readonly max: number) {}
  get count(): number {
    return this.#count;
  }
  get full(): boolean {
    return this.#count >= this.max;
  }
  add(): void {
    this.#count++;
  }
  remove(): void {
    this.#count--;
  }
}
