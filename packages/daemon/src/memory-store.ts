// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { JsonValue } from "@axis/protocol";
import type { IdempotencyBegin, IdempotencyKey, IdempotencyStore } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

interface Entry {
  readonly hash: string;
  readonly budget: string;
  at: number;
  result?: JsonValue;
  origin?: string;
  unknown?: "interrupted" | "failed-after-start";
}

export interface MemoryStoreOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
  /** Entries across all actors. Default 10 000. */
  readonly maxEntries?: number;
  /** Entries one actor may hold in one workspace. Default 1 000. */
  readonly maxPerActor?: number;
  /** Minimum time between expiry sweeps. Default one minute. */
  readonly sweepEveryMs?: number;
}

/**
 * TESTS AND DEV WIRING ONLY. It forgets everything on restart, so a retry
 * after a crash would run a side effect twice; the product uses the
 * journal-backed store (ADR 0003 D3, 24 h).
 *
 * Bounds: an actor in a workspace can only ever evict its own completed entries there, never
 * another actor's and never an in-progress one. When an actor, or the whole
 * store, is full of live entries, `begin` answers `exhausted`. Expiry runs as
 * an amortised sweep (at most once per `sweepEveryMs`), not on every call.
 * In-progress entries do not expire: the daemon always settles them.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #entries = new Map<string, Entry>();
  readonly #byActor = new Map<string, Set<string>>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #maxPerActor: number;
  readonly #sweepEveryMs: number;
  #lastSweep: number;

  constructor(options: MemoryStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? DAY_MS;
    this.#maxEntries = options.maxEntries ?? 10_000;
    this.#maxPerActor = options.maxPerActor ?? 1_000;
    this.#sweepEveryMs = options.sweepEveryMs ?? 60_000;
    this.#lastSweep = this.#now();
  }

  get size(): number {
    return this.#entries.size;
  }

  /** The budget owner: an actor in a workspace cannot evict the same actor's entries in another. */
  #budget(k: IdempotencyKey): string {
    return JSON.stringify([k.actorId, k.workspaceId]);
  }

  #id(k: IdempotencyKey): string {
    return JSON.stringify([k.actorId, k.workspaceId, k.contract, k.version, k.method, k.key]);
  }

  #drop(id: string, e: Entry): void {
    this.#entries.delete(id);
    const set = this.#byActor.get(e.budget);
    set?.delete(id);
    if (set?.size === 0) this.#byActor.delete(e.budget);
  }

  #expired(e: Entry, t: number): boolean {
    return (e.result !== undefined || e.unknown !== undefined) && t - e.at >= this.#ttlMs;
  }

  #sweep(t: number): void {
    if (t - this.#lastSweep < this.#sweepEveryMs) return;
    this.#lastSweep = t;
    for (const [id, e] of this.#entries) if (this.#expired(e, t)) this.#drop(id, e);
  }

  begin(key: IdempotencyKey, hash: string): IdempotencyBegin {
    const t = this.#now();
    this.#sweep(t);
    const id = this.#id(key);
    const found = this.#entries.get(id);
    if (found && this.#expired(found, t)) this.#drop(id, found);
    else if (found) {
      if (found.hash !== hash) return { state: "conflict" };
      if (found.unknown) return { state: "unknown", reason: found.unknown };
      return found.result === undefined
        ? { state: "in-progress" }
        : { state: "replay", result: found.result, origin: found.origin ?? "" };
    }
    const budget = this.#budget(key);
    const mine = this.#byActor.get(budget);
    if (mine && mine.size >= this.#maxPerActor && !this.#evictOldestCompleted(mine)) return { state: "exhausted" };
    if (this.#entries.size >= this.#maxEntries) return { state: "exhausted" };
    const entry: Entry = { hash, budget, at: t };
    this.#entries.set(id, entry);
    if (mine) mine.add(id);
    else this.#byActor.set(budget, new Set([id]));
    return { state: "new" };
  }

  #evictOldestCompleted(ids: Set<string>): boolean {
    for (const id of ids) {
      const e = this.#entries.get(id);
      if (e && e.result !== undefined && !e.unknown) {
        this.#drop(id, e);
        return true;
      }
    }
    return false;
  }

  complete(key: IdempotencyKey, result: JsonValue, origin: string): void {
    const e = this.#entries.get(this.#id(key));
    if (e) {
      e.result = result;
      e.origin = origin;
    }
  }

  abandon(key: IdempotencyKey): void {
    const id = this.#id(key);
    const e = this.#entries.get(id);
    if (e && e.result === undefined && !e.unknown) this.#drop(id, e);
  }

  markUnknown(key: IdempotencyKey): void {
    const e = this.#entries.get(this.#id(key));
    if (e && e.result === undefined) {
      e.unknown = "failed-after-start";
      e.at = this.#now();
    }
  }
}
