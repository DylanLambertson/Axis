// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { listedChallengeSchema, MAX_LISTED_SUMMARY, MAX_PENDING_CHALLENGES, type Challenge } from "@axis/protocol";

/**
 * What `axis.approvals/1.pending` lists. `@axis/challenge` has no listing call, so the host remembers the wire
 * challenges it issued (the same value the requester received, no proof and no secret) and forgets each one when it
 * ends: resolved, consumed, withdrawn, expired or answered by the native dialog. A listing is a convenience for the
 * UI and carries no authority: an id here cannot be used by anyone but the requester, and `resolve` still goes
 * through the manager, which refuses an unknown or wrong-window id. A challenge the manager burned without telling
 * the host (a mismatched retry) stays listed until it expires; resolving it is refused.
 */
interface Entry {
  readonly challenge: Challenge;
  readonly windowId: string;
  readonly connectionId: string;
  /** Monotonic deadline, from the same clock the manager uses. */
  readonly expiresAt: number;
}

/**
 * Shorten to at most `max` UTF-16 code units (what the contract's `displayTextSchema` counts): head, an ellipsis, tail,
 * every cut on a code point boundary so a surrogate pair is never split.
 */
export function shortenSummary(text: string, max: number = MAX_LISTED_SUMMARY): string {
  if (text.length <= max) return text;
  const room = max - 1;
  const headRoom = Math.ceil(room / 2);
  const points = Array.from(text);
  let head = "";
  for (const p of points) {
    if (head.length + p.length > headRoom) break;
    head += p;
  }
  let tail = "";
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i] as string;
    if (head.length + tail.length + p.length > room) break;
    tail = p + tail;
  }
  return `${head}\u2026${tail}`;
}

export class PendingRegistry {
  readonly #entries = new Map<string, Entry>();
  readonly #monotonic: () => number;
  readonly #ttlMs: number;
  readonly #cap: number;
  #evicted = 0;

  constructor(options: { monotonic: () => number; ttlMs: number; cap: number }) {
    this.#monotonic = options.monotonic;
    this.#ttlMs = options.ttlMs;
    this.#cap = options.cap;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Entries dropped to stay inside the cap (never a live prompt in normal use: the cap exceeds the manager's quota). */
  get evicted(): number {
    return this.#evicted;
  }

  add(challenge: Challenge, windowId: string, connectionId: string): void {
    const now = this.#monotonic();
    this.#sweep(now);
    while (this.#entries.size >= this.#cap) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
      this.#evicted++;
    }
    this.#entries.set(challenge.challengeId, { challenge, windowId, connectionId, expiresAt: now + this.#ttlMs });
  }

  remove(challengeId: string): void {
    this.#entries.delete(challengeId);
  }

  removeConnection(connectionId: string): void {
    for (const [id, e] of this.#entries) if (e.connectionId === connectionId) this.#entries.delete(id);
  }

  clear(): void {
    this.#entries.clear();
  }

  /** The open challenges of one window, oldest first, each shaped for the listing contract. */
  list(windowId: string): Challenge[] {
    this.#sweep(this.#monotonic());
    const out: Challenge[] = [];
    for (const e of this.#entries.values()) {
      if (e.windowId !== windowId) continue;
      const listed = listedChallengeSchema.safeParse({ ...e.challenge, targetSummary: shortenSummary(e.challenge.targetSummary) });
      // A challenge that cannot be shown in the contract's shape is left out, not repaired.
      if (listed.success) out.push(listed.data);
    }
    return out.slice(-MAX_PENDING_CHALLENGES);
  }

  #sweep(now: number): void {
    for (const [id, e] of this.#entries) if (now >= e.expiresAt) this.#entries.delete(id);
  }
}
