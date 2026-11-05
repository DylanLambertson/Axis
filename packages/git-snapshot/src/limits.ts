// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { performance } from "node:perf_hooks";
import { SnapshotError } from "./errors.js";

/** Every bound the snapshot enforces. Exceeding one makes the snapshot incomplete; nothing is silently skipped. */
export interface Limits {
  /** Entries (files, directories, links) in one snapshot. */
  readonly maxEntries: number;
  /** Bytes read and parsed from one config file. */
  readonly maxConfigBytes: number;
  /** Bytes hashed from one other file. */
  readonly maxFileBytes: number;
  /** Bytes read in total. */
  readonly maxTotalBytes: number;
  /** Characters of redacted text kept per entry. */
  readonly maxTextChars: number;
  /** Wall clock for one snapshot. */
  readonly maxMillis: number;
  readonly maxIncludeDepth: number;
  readonly maxIncludeFiles: number;
  /** Directory depth below an in-tree hook directory. */
  readonly maxWalkDepth: number;
  readonly maxWorktrees: number;
  readonly maxRefs: number;
  /** Parsed settings kept per snapshot. */
  readonly maxSettings: number;
  /** Bytes of `git ls-files` output scanned for index flags. */
  readonly maxIndexBytes: number;
}

export const DEFAULT_LIMITS: Limits = Object.freeze({
  maxEntries: 4096,
  maxConfigBytes: 4 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxTextChars: 16 * 1024,
  maxMillis: 10_000,
  maxIncludeDepth: 10,
  maxIncludeFiles: 64,
  maxWalkDepth: 4,
  maxWorktrees: 1024,
  maxRefs: 4096,
  maxSettings: 2048,
  maxIndexBytes: 512 * 1024 * 1024,
});

/** What the snapshot schema allows for one entry's text, less room for a header line. */
const MAX_TEXT_CHARS = 60_000;

export function resolveLimits(over: Partial<Limits> | undefined): Limits {
  const out: Record<string, number> = { ...DEFAULT_LIMITS };
  for (const [k, v] of Object.entries(over ?? {})) {
    if (!(k in out) || typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) {
      throw new SnapshotError("E_INVALID_ARGUMENT", "invalid snapshot limit");
    }
    out[k] = v;
  }
  // A kept text longer than the schema allows would make a saved snapshot impossible to load.
  out["maxTextChars"] = Math.min(out["maxTextChars"] as number, MAX_TEXT_CHARS);
  return Object.freeze(out) as unknown as Limits;
}

/** A bound that stops the whole collection; the snapshot taken so far is returned as incomplete. */
export class Exhausted extends Error {
  readonly bound: string;
  constructor(bound: string) {
    super("limit");
    this.name = "Exhausted";
    this.bound = bound;
  }
}

/** Shared by every read of one snapshot: time, bytes, entries and cancellation. */
export class Budget {
  readonly #start = performance.now();
  #bytes = 0;
  #entries = 0;
  constructor(
    private readonly limits: Limits,
    readonly signal: AbortSignal | undefined,
  ) {}

  /** Milliseconds left of the wall clock (never negative). */
  remaining(): number {
    return Math.max(0, this.limits.maxMillis - (performance.now() - this.#start));
  }

  /** Throws `E_CANCELLED` when aborted, `Exhausted` when the time is spent. */
  tick(): void {
    if (this.signal?.aborted === true) throw new SnapshotError("E_CANCELLED", "snapshot cancelled");
    if (performance.now() - this.#start > this.limits.maxMillis) throw new Exhausted("time");
  }
  addBytes(n: number): void {
    this.#bytes += n;
    if (this.#bytes > this.limits.maxTotalBytes) throw new Exhausted("total-bytes");
  }
  addEntry(): void {
    this.#entries += 1;
    if (this.#entries > this.limits.maxEntries) throw new Exhausted("entries");
  }
}
