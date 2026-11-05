// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { ChainHead } from "@axis/audit";
import { DaemonError } from "@axis/daemon";
import type { Disposables } from "../disposables.js";
import type { Clock } from "../ports/clock.js";

/**
 * The anchor manager (design section 5.4). After audited writes it asks the audit log for a checkpoint and sends
 * `anchor.put` to the supervisor, which owns the stored anchor and answers `anchor.ack` once the value is durable.
 * The host persists nothing itself.
 *
 * It tracks the lag (events not covered by an acknowledged anchor) and the age of the oldest anchor still waiting.
 * Past either limit the host is `stalled` and every method of tier 3 and above is refused with `E_UNAVAILABLE`
 * (`details.reason: "anchor_stalled"`) until acknowledgements come back; reads and tiers 0 to 2 continue.
 *
 *  - Only the monotonic clock is read, so a wall-clock jump can neither stall the host nor hide a stall.
 *  - An acknowledgement only ever moves forward, and only to a sequence this process sent (or the anchor the
 *    supervisor held at start): a duplicate, a regression or an ack for something never put is ignored, so a buggy
 *    supervisor cannot lift a stall it did not earn.
 *  - Nothing is dropped or reordered: every head goes out in order. The list of waiting puts is bounded by merging
 *    the middle entries (an ack is cumulative, so only the oldest and the newest matter).
 *  - A burst of more than `maxLagEvents` audited events between two ack round trips stalls tier 3 and above for as
 *    long as the acks take; that is deliberate (fail closed) and self-healing.
 *  - A broken chain stalls for good but is not audited: the log is the thing that failed.
 *  - One interval timer (registered with the lifecycle registry, `unref`ed) retries a failed send and flushes the
 *    writes that were coalesced within `coalesceMs`.
 */

export const DEFAULT_MAX_LAG_EVENTS = 1000;
export const DEFAULT_MAX_AGE_MS = 5 * 60_000;
export const DEFAULT_COALESCE_MS = 500;
const MAX_WAITING_PUTS = 64;

/** The part of the audit log the manager needs. `checkpoint` and `append` are absent in degraded mode. */
export interface AnchorAudit {
  head(): ChainHead | null;
  checkpoint?(since?: ChainHead): ChainHead | null;
  append?(input: { actor: "daemon"; action: string; target: string; outcome: "success"; payload: Record<string, string | number> }): unknown;
}

export interface AnchorManagerOptions {
  readonly clock: Pick<Clock, "monotonic">;
  readonly audit: AnchorAudit;
  /** Sends `anchor.put`. May throw (a closed channel); the head then stays unsent and is retried. */
  readonly put: (head: ChainHead) => void;
  /** The anchor the supervisor held at startup (`null` for none). */
  readonly baseline: ChainHead | null;
  /** False in degraded mode: nothing is sent, nothing stalls, the status is still reported. */
  readonly writable: boolean;
  readonly disposables: Disposables;
  readonly maxLagEvents?: number;
  readonly maxAgeMs?: number;
  readonly coalesceMs?: number;
  /** Called once per transition with the new state (a closed set; never text). */
  readonly onTransition?: (stalled: boolean) => void;
}

export interface AnchorStatus {
  readonly head: ChainHead | null;
  /** The newest anchor the supervisor acknowledged, or the one it held at start. */
  readonly anchor: ChainHead | null;
  readonly lag: number;
  readonly oldestUnackedAgeMs: number | null;
  readonly stalled: boolean;
}

/** What handlers and the approval gate adapter may use: no put, no ack, no timer. */
export interface AnchorGuard {
  /** Throws the closed `E_UNAVAILABLE` error when a method of this tier must be refused. */
  check(tier: number): void;
  status(): AnchorStatus;
  /** Tell the manager an audited write happened (the audit sink calls this). */
  noteWrite(): void;
}

export class AnchorManager implements AnchorGuard {
  readonly #o: AnchorManagerOptions;
  readonly #maxLag: number;
  readonly #maxAge: number;
  readonly #coalesce: number;
  readonly #waiting: Array<{ head: ChainHead; at: number }> = [];
  #ackedHead: ChainHead | null;
  #lastPut: ChainHead | null = null;
  #lastPutAt = Number.NEGATIVE_INFINITY;
  /** When the first write not yet covered by a sent put happened. */
  #dirtySince: number | undefined;
  #broken = false;
  #stalled = false;
  #stopped = false;

  constructor(options: AnchorManagerOptions) {
    this.#o = options;
    this.#maxLag = positive(options.maxLagEvents, DEFAULT_MAX_LAG_EVENTS);
    this.#maxAge = positive(options.maxAgeMs, DEFAULT_MAX_AGE_MS);
    this.#coalesce = positive(options.coalesceMs, DEFAULT_COALESCE_MS);
    this.#ackedHead = options.baseline;
    if (options.writable) {
      options.disposables.setInterval(() => this.tick(), this.#coalesce, "anchor.tick");
      options.disposables.add(() => void (this.#stopped = true), "anchor.manager");
    }
  }

  /** The newest head this process put (`null` before the first), and the highest acknowledged sequence. */
  get put(): ChainHead | null {
    return this.#lastPut;
  }
  /** Puts sent and not yet acknowledged (bounded). */
  get waiting(): number {
    return this.#waiting.length;
  }
  get ackedSeq(): number {
    return this.#ackedHead?.seq ?? 0;
  }

  /** An audited write happened: send a checkpoint now, or leave it to the next tick when one went out recently. */
  noteWrite(): void {
    if (!this.#o.writable || this.#stopped) return;
    const now = this.#o.clock.monotonic();
    this.#dirtySince ??= now;
    if (now - this.#lastPutAt >= this.#coalesce) this.flush();
    this.evaluate();
  }

  /** Checkpoint and send the newest head if it is past everything already sent. Never throws. */
  flush(): void {
    if (!this.#o.writable || this.#stopped || this.#o.audit.checkpoint === undefined) return;
    let head: ChainHead | null;
    try {
      head = this.#o.audit.checkpoint(this.#lastPut ?? this.#o.baseline ?? undefined);
    } catch {
      // The chain no longer verifies from the last sent head: never anchor it, refuse tier 3 and above.
      this.#broken = true;
      return;
    }
    const sent = Math.max(this.#lastPut?.seq ?? 0, this.#o.baseline?.seq ?? 0);
    if (head === null || head.seq <= sent) {
      this.#dirtySince = undefined;
      return;
    }
    const now = this.#o.clock.monotonic();
    // Record the put BEFORE sending: a supervisor on a synchronous link may acknowledge from inside `put`, and that
    // ack must find the put. A send that throws is rolled back, so nothing unsent is ever waited on.
    const previous = { last: this.#lastPut, at: this.#lastPutAt, dirty: this.#dirtySince };
    this.#waiting.push({ head, at: now });
    this.#lastPut = head;
    this.#lastPutAt = now;
    this.#dirtySince = undefined;
    try {
      this.#o.put(head);
    } catch {
      // Not sent: undo (unless an ack already consumed the entry), stay dirty, retry on the next tick.
      const i = this.#waiting.findIndex((w) => w.head === head);
      if (i >= 0) this.#waiting.splice(i, 1);
      if (this.#lastPut === head) {
        this.#lastPut = previous.last;
        this.#lastPutAt = previous.at;
      }
      this.#dirtySince = previous.dirty ?? now;
      return;
    }
    // Merge the middle once the list is full: an ack is cumulative, so the oldest and the newest are what matter.
    if (this.#waiting.length > MAX_WAITING_PUTS) this.#waiting.splice(1, 1);
  }

  /** `anchor.ack`. Returns whether it moved the acknowledged position. */
  ack(seq: number): boolean {
    if (this.#stopped || !Number.isSafeInteger(seq) || seq <= this.ackedSeq) return false;
    // Nothing above the newest head this process sent can be durable: such an ack is ignored, never believed.
    if (this.#lastPut === null || seq > this.#lastPut.seq) return false;
    let covered: ChainHead | undefined;
    let n = 0;
    // Waiting puts are in ascending order; an ack covers every put up to and including its sequence.
    while (n < this.#waiting.length && (this.#waiting[n] as { head: ChainHead }).head.seq <= seq) {
      covered = (this.#waiting[n] as { head: ChainHead }).head;
      n++;
    }
    if (covered === undefined) return false; // for something this process never sent
    this.#waiting.splice(0, n);
    this.#ackedHead = covered;
    this.evaluate();
    return true;
  }

  status(): AnchorStatus {
    const head = this.#safeHead();
    const stalled = this.evaluate();
    return {
      head: head ?? null,
      anchor: this.#ackedHead,
      lag: this.#lag(head),
      oldestUnackedAgeMs: this.#age(),
      stalled,
    };
  }

  check(tier: number): void {
    if (tier >= 3 && this.evaluate()) {
      throw new DaemonError("E_UNAVAILABLE", "The audit anchor is not being acknowledged.", { reason: "anchor_stalled" });
    }
  }

  /** Recompute the stalled state; reports a transition once. */
  evaluate(): boolean {
    if (!this.#o.writable) return false;
    const head = this.#safeHead();
    const age = this.#age();
    // A log that ends before a position the supervisor acknowledged was cut: never anchor it, refuse tier 3 and above.
    if (head !== undefined && (head?.seq ?? 0) < this.ackedSeq) this.#broken = true;
    const stalled = this.#broken || head === undefined || this.#lag(head) > this.#maxLag || (age !== null && age > this.#maxAge);
    if (stalled !== this.#stalled) {
      this.#stalled = stalled;
      this.#audit(stalled);
      try {
        this.#o.onTransition?.(stalled);
      } catch {
        // a failing observer never changes the decision
      }
    }
    return this.#stalled;
  }

  /** Flush what is unsent and re-evaluate. The interval calls it; tests call it directly. */
  tick(): void {
    if (!this.#o.writable || this.#stopped) return;
    const head = this.#safeHead();
    const sent = Math.max(this.#lastPut?.seq ?? 0, this.#o.baseline?.seq ?? 0);
    // Writes by other writers (the journal, the challenge sink) are noticed here, not only those that call noteWrite.
    if (head !== null && head !== undefined && head.seq > sent) {
      this.#dirtySince ??= this.#o.clock.monotonic();
      this.flush();
    }
    this.evaluate();
  }

  /** `null` for an empty log; `undefined` when the log cannot be read (which stalls, fail closed). */
  #safeHead(): ChainHead | null | undefined {
    try {
      return this.#o.audit.head();
    } catch {
      return undefined;
    }
  }

  #lag(head: ChainHead | null | undefined): number {
    return head === null || head === undefined ? 0 : Math.max(0, head.seq - this.ackedSeq);
  }

  #age(): number | null {
    const since = this.#waiting[0]?.at ?? this.#dirtySince;
    return since === undefined ? null : Math.max(0, Math.floor(this.#o.clock.monotonic() - since));
  }

  /** One audit row per transition, written best effort: a failing append must not change the decision. */
  #audit(stalled: boolean): void {
    if (this.#broken || this.#o.audit.append === undefined) return;
    try {
      this.#o.audit.append({
        actor: "daemon",
        action: stalled ? "anchor.stalled" : "anchor.resumed",
        target: "daemon:anchor",
        outcome: "success",
        payload: stalled ? { reason: "anchor_stalled" } : { code: "resumed" },
      });
    } catch {
      // the log is the thing that failed; the stall itself is already in force
    }
  }
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
