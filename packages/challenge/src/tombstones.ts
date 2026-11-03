// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { ActorId } from "./schemas.js";

interface Tombstone {
  readonly requester: ActorId;
  readonly windowId: string;
  /** Monotonic: the challenge's original expiry. */
  readonly until: number;
}

/**
 * What a withdrawn challenge leaves behind. A withdrawn challenge no longer
 * exists for resolve or consume, but it keeps counting against its requester's
 * quotas until the time it would have expired anyway. Without this, an agent
 * could loop issue and withdraw and put any number of prompts in front of the
 * user inside one TTL. Only the requester, window and deadline are kept.
 */
export class Tombstones {
  readonly #byRef = new Map<string, Tombstone>();

  add(ref: string, requester: ActorId, windowId: string, until: number): void {
    this.#byRef.set(ref, { requester, windowId, until });
  }

  /** Drops the ones past their deadline. */
  sweep(now: number): void {
    for (const [ref, t] of this.#byRef) if (now >= t.until) this.#byRef.delete(ref);
  }

  /** Live tombstones: overall, for one requester and for one window. */
  count(requester: string, windowId: string): { total: number; actor: number; window: number } {
    let actor = 0;
    let window = 0;
    for (const t of this.#byRef.values()) {
      if (t.requester === requester) actor++;
      if (t.windowId === windowId) window++;
    }
    return { total: this.#byRef.size, actor, window };
  }

  get size(): number {
    return this.#byRef.size;
  }
}
