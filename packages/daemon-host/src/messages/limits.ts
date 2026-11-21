// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * The limits of docs/design/inter-agent-communication.md section 7 (proposed defaults; a test build lowers them). Every
 * one is enforced by the message service and refused with a closed reason; every in-memory structure here is bounded.
 */
export interface MessagingLimits {
  /** Sends per agent or plugin sender per minute (`rate_limited`). */
  readonly sendsPerMinute: number;
  /** Sends per run in all (`rate_limited`). */
  readonly sendsPerRun: number;
  /** Sends per project per minute, agents and plugins together (`rate_limited`). */
  readonly projectSendsPerMinute: number;
  /** Reads (`thread`, `threads`, `read`, `markRead`) per agent or plugin caller per minute (`rate_limited`). */
  readonly readsPerMinute: number;
  /** Unread messages from agents and plugins one recipient holds (`queue_full`, section 7.2). */
  readonly queuePerRecipient: number;
  /** Of those, from one sender (`queue_full`). */
  readonly queuePerSender: number;
  /** Messages one thread holds (`too_large`: start a new thread). */
  readonly messagesPerThread: number;
  /** Threads one project holds (`queue_full`). */
  readonly threadsPerProject: number;
  /** Senders, runs and readers the counters remember at once; a new key past it is refused until one expires. */
  readonly maxTrackedKeys: number;
}

export const DEFAULT_MESSAGING_LIMITS: MessagingLimits = Object.freeze({
  sendsPerMinute: 30,
  sendsPerRun: 500,
  projectSendsPerMinute: 300,
  readsPerMinute: 60,
  queuePerRecipient: 200,
  queuePerSender: 50,
  messagesPerThread: 2_000,
  threadsPerProject: 10_000,
  maxTrackedKeys: 4_096,
});

const UPPER = 1_000_000;
export function checkLimits(over: Partial<MessagingLimits> = {}): MessagingLimits {
  const out = { ...DEFAULT_MESSAGING_LIMITS, ...over };
  for (const [k, v] of Object.entries(out)) {
    if (!Number.isSafeInteger(v) || v < 1 || v > UPPER) throw new RangeError(`messaging limit ${k} is out of range`);
  }
  if (out.queuePerSender > out.queuePerRecipient) throw new RangeError("messaging limit queuePerSender is out of range");
  return Object.freeze(out);
}

export const MINUTE_MS = 60_000;

/**
 * At most `limit` events per key in any window of `windowMs` (monotonic milliseconds). Each key keeps at most `limit`
 * times; at most `maxKeys` keys are kept, and when they are all live a new key is refused (fail closed) instead of
 * forgetting a sender that is still being limited.
 */
export class WindowCounter {
  readonly #events = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys: number,
    private readonly now: () => number,
  ) {}

  /** Count one event for `key`; false (nothing counted) when the key is at its limit or no key can be kept. */
  take(key: string): boolean {
    const t = this.now();
    let times = this.#events.get(key);
    if (times === undefined) {
      if (this.#events.size >= this.maxKeys) this.#sweep(t);
      if (this.#events.size >= this.maxKeys) return false;
      times = [];
      this.#events.set(key, times);
    }
    while (times.length > 0 && t - (times[0] as number) >= this.windowMs) times.shift();
    if (times.length >= this.limit) return false;
    times.push(t);
    return true;
  }

  get size(): number {
    return this.#events.size;
  }

  #sweep(t: number): void {
    for (const [key, times] of this.#events) {
      if (times.length === 0 || t - (times[times.length - 1] as number) >= this.windowMs) this.#events.delete(key);
    }
  }
}

/**
 * At most `limit` events per key in all (sends per run). Keeps `maxKeys` keys; past it the oldest key is forgotten, so a
 * run whose count is forgotten could send again: that run is the longest idle one, and the per-minute counters still hold.
 */
export class TotalCounter {
  readonly #counts = new Map<string, number>();
  constructor(
    private readonly limit: number,
    private readonly maxKeys: number,
  ) {}

  take(key: string): boolean {
    const n = this.#counts.get(key) ?? 0;
    // Refreshed even when refused: a run that keeps trying at its limit stays the most recent key, never the one forgotten.
    this.#counts.delete(key);
    this.#counts.set(key, Math.min(n + 1, this.limit));
    if (this.#counts.size > this.maxKeys) this.#counts.delete(this.#counts.keys().next().value as string);
    if (n >= this.limit) return false;
    return true;
  }

  get size(): number {
    return this.#counts.size;
  }
}
