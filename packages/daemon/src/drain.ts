// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * Daemon-wide shutdown state shared with every session: whether new requests
 * are still accepted, and how many admitted requests have not settled.
 *
 * `running` is counted from admission until the pipeline promise settles, the
 * same moment the in-flight slot is released, so a request whose caller was
 * already answered (timeout, cancel, close) still counts while its handler
 * runs. Nothing here frees a slot; it only observes them.
 */
export class DrainGate {
  #draining = false;
  #running = 0;
  #idle: Array<() => void> = [];

  get draining(): boolean {
    return this.#draining;
  }

  /** Admitted requests whose pipeline has not settled. */
  get running(): number {
    return this.#running;
  }

  /** From now on sessions refuse new requests. */
  begin(): void {
    this.#draining = true;
  }

  enter(): void {
    this.#running++;
  }

  leave(): void {
    if (this.#running > 0) this.#running--;
    if (this.#running === 0) for (const wake of this.#idle.splice(0)) wake();
  }

  /** Register a one-shot callback for the moment nothing is running (immediately if nothing is). Returns an unsubscribe. */
  onIdle(wake: () => void): () => void {
    if (this.#running === 0) {
      wake();
      return () => undefined;
    }
    this.#idle.push(wake);
    return () => {
      const i = this.#idle.indexOf(wake);
      if (i >= 0) this.#idle.splice(i, 1);
    };
  }
}
