// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import type { NativeConfirmRequest, NativeConfirmResult, RequestOptions } from "../control/client.js";

/**
 * The native confirmation path of a tier 4 or 5 challenge (design section 5.2). The proof taken from the manager goes
 * to the supervisor in `native.confirm` and nowhere else; the supervisor's `native.result` comes back through
 * `ControlClient.nativeConfirm`, which only accepts an answer whose challenge id, window and proof match a request
 * that is waiting (anything else is ignored and counted there, so there is no result without a request).
 *
 * The user's `resolve(approve)` and the dialog's answer may arrive in either order. The manager needs the user's
 * approval first, so an answer that comes early is held (one boolean per challenge) and applied when the user
 * approves; a user denial or a withdrawal drops it. A dialog the user cancelled, a supervisor that did not answer in
 * time and a closed channel are all the same thing: a refusal (`confirmed: false`). Nothing here ever turns a
 * failure into an approval. No timers of its own: the control client owns the timeout and removes it.
 */
export interface NativeControl {
  nativeConfirm(request: NativeConfirmRequest, options?: RequestOptions): Promise<NativeConfirmResult>;
}

/** Applies the answer to the manager. Receives the proof the host itself took, never one from the supervisor. */
export type ApplyNative = (answer: { challengeId: string; windowId: string; proof: string; confirmed: boolean }) => void;

export interface NativeBridgeOptions {
  readonly control: NativeControl;
  readonly apply: ApplyNative;
  /** Monotonic ms, the clock the manager uses. */
  readonly monotonic: () => number;
  /** How long a challenge lives; an entry older than this is dropped. */
  readonly ttlMs: number;
  /**
   * Native waits at once; more is `E_BACKPRESSURE`. Each wait holds one slot of the control client (64 by default,
   * shared with `trust.check`, `anchor.get` and `settings.get`), so this stays well below that.
   */
  readonly maxEntries: number;
  /** Native waits of one window at once (default: half of `maxEntries`, rounded up), so one window cannot take every slot. */
  readonly maxPerWindow?: number;
  /** A wait that failed for a reason other than the user or the clock (channel closed, no slot) after `start` returned. */
  readonly onLost?: (lost: { challengeId: string; connectionId: string; actor: string }) => void;
}

export interface NativeStats {
  readonly entries: number;
  /** Answers applied with `confirmed: true` / `false`. */
  readonly confirmed: number;
  readonly refused: number;
  /** Refusals that came from a failure (timeout, closed channel), not from the user. */
  readonly failed: number;
  /** `apply` calls that threw (challenge already ended, wrong state). */
  readonly applyErrors: number;
  /** Waits that could not be started or died for another reason than a timeout or a cancel. */
  readonly lost: number;
}

interface Entry {
  readonly challengeId: string;
  readonly proof: string;
  readonly windowId: string;
  readonly connectionId: string;
  readonly actor: string;
  readonly controller: AbortController;
  readonly expiresAt: number;
  approved: boolean;
  answer: boolean | undefined;
}

export class NativeBridge {
  readonly #opts: NativeBridgeOptions;
  readonly #entries = new Map<string, Entry>();
  #confirmed = 0;
  #refused = 0;
  #failed = 0;
  #lost = 0;
  #applyErrors = 0;
  #disposed = false;
  readonly #perWindow: number;
  readonly #reserved = new Map<string, number>();
  #reservedTotal = 0;

  constructor(options: NativeBridgeOptions) {
    const ok = (n: number | undefined, max: number): boolean => n === undefined || (Number.isInteger(n) && n >= 1 && n <= max);
    if (!ok(options.maxEntries, 1024) || options.maxEntries === undefined || !ok(options.maxPerWindow, options.maxEntries)) {
      throw new AxisError("E_INVALID_ARGUMENT", "Invalid native wait limit");
    }
    this.#opts = options;
    this.#perWindow = options.maxPerWindow ?? Math.ceil(options.maxEntries / 2);
  }

  /**
   * Take a place for a wait BEFORE the challenge is issued, so a full bridge refuses with no challenge, no audit row
   * and no quota used. `undefined` when the bridge is full or the window already holds its share. `start` takes the
   * place over; `release` gives it back (idempotent) when the challenge was never started.
   */
  reserve(windowId: string): { release(): void } | undefined {
    if (this.#disposed) return undefined;
    this.#sweep();
    if (!this.#room(windowId)) return undefined;
    this.#reserved.set(windowId, (this.#reserved.get(windowId) ?? 0) + 1);
    this.#reservedTotal++;
    let held = true;
    return {
      release: () => {
        if (!held) return;
        held = false;
        this.#reservedTotal--;
        const n = (this.#reserved.get(windowId) ?? 1) - 1;
        if (n <= 0) this.#reserved.delete(windowId);
        else this.#reserved.set(windowId, n);
      },
    };
  }

  #room(windowId: string): boolean {
    let inWindow = this.#reserved.get(windowId) ?? 0;
    for (const e of this.#entries.values()) if (e.windowId === windowId) inWindow++;
    return this.#entries.size + this.#reservedTotal < this.#opts.maxEntries && inWindow < this.#perWindow;
  }

  stats(): NativeStats {
    this.#sweep();
    return Object.freeze({
      entries: this.#entries.size,
      confirmed: this.#confirmed,
      refused: this.#refused,
      failed: this.#failed,
      applyErrors: this.#applyErrors,
      lost: this.#lost,
    });
  }

  /**
   * Send `native.confirm`. Rejects (and keeps nothing) when the bridge is full or closed, or when the control client
   * refuses the request at once (channel closed, no free slot): the caller then withdraws the challenge, so the user is
   * never shown one whose dialog cannot open. A failure that comes later is reported through `onLost`.
   */
  async start(
    request: NativeConfirmRequest & { readonly connectionId: string; readonly actor: string },
    reservation?: { release(): void },
  ): Promise<void> {
    // The reserved place becomes this entry (or is given back if the start fails): never counted twice.
    reservation?.release();
    if (this.#disposed) throw new AxisError("E_UNAVAILABLE", "The native confirmation is closed", { reason: "bridge_closed" });
    this.#sweep();
    if (this.#entries.has(request.challengeId) || (reservation === undefined && !this.#room(request.windowId))) {
      throw new AxisError("E_BACKPRESSURE", "Too many native confirmations are waiting");
    }
    const { connectionId, actor, ...wire } = request;
    const entry: Entry = {
      challengeId: wire.challengeId,
      proof: wire.proof,
      windowId: wire.windowId,
      connectionId,
      actor,
      controller: new AbortController(),
      expiresAt: this.#opts.monotonic() + this.#opts.ttlMs,
      approved: false,
      answer: undefined,
    };
    this.#entries.set(entry.challengeId, entry);
    let pending: Promise<NativeConfirmResult>;
    try {
      pending = this.#opts.control.nativeConfirm(wire, { signal: entry.controller.signal, timeoutMs: this.#opts.ttlMs });
    } catch (e) {
      this.#entries.delete(entry.challengeId);
      throw e;
    }
    let started = false;
    let lost: string | undefined;
    pending.then(
      (result) => this.#answered(entry, result.confirmed === true, false),
      (error: unknown) => {
        const code = (error as { code?: unknown } | null)?.code;
        // A timeout or a cancel is the user's or the clock's answer: a refusal. Anything else means the wait never worked.
        if (this.#entries.get(entry.challengeId) !== entry || code === "E_TIMEOUT" || code === "E_CANCELLED") {
          this.#answered(entry, false, true);
          return;
        }
        this.#entries.delete(entry.challengeId);
        this.#lost++;
        if (started) this.#opts.onLost?.({ challengeId: entry.challengeId, connectionId, actor });
        else lost = typeof code === "string" ? code : "E_UNAVAILABLE";
      },
    );
    // One turn of the event loop: a request the control client refused at once has rejected by now.
    await new Promise<void>((r) => setImmediate(r));
    started = true;
    if (lost !== undefined) {
      throw new AxisError(lost === "E_BACKPRESSURE" ? "E_BACKPRESSURE" : "E_UNAVAILABLE", "The native confirmation could not be started");
    }
  }

  /** The user approved the challenge in the window: apply the dialog's answer now, or when it arrives. */
  userApproved(challengeId: string): void {
    this.#sweep();
    const entry = this.#entries.get(challengeId);
    if (entry === undefined) return;
    entry.approved = true;
    if (entry.answer !== undefined) this.#apply(entry);
  }

  /** The challenge ended for any other reason (denied, expired, consumed, withdrawn): forget it and cancel the wait. */
  end(challengeId: string): void {
    this.#sweep();
    const entry = this.#entries.get(challengeId);
    if (entry === undefined) return;
    this.#entries.delete(challengeId);
    entry.controller.abort();
  }

  endConnection(connectionId: string): void {
    for (const entry of [...this.#entries.values()]) if (entry.connectionId === connectionId) this.end(entry.challengeId);
  }

  dispose(): void {
    this.#disposed = true;
    for (const id of [...this.#entries.keys()]) this.end(id);
  }

  #answered(entry: Entry, confirmed: boolean, failure: boolean): void {
    if (this.#entries.get(entry.challengeId) !== entry || entry.answer !== undefined) return;
    if (failure) this.#failed++;
    entry.answer = confirmed;
    if (entry.approved) this.#apply(entry);
  }

  #apply(entry: Entry): void {
    this.#entries.delete(entry.challengeId);
    const confirmed = entry.answer === true;
    if (confirmed) this.#confirmed++;
    else this.#refused++;
    try {
      this.#opts.apply({ challengeId: entry.challengeId, windowId: entry.windowId, proof: entry.proof, confirmed });
    } catch {
      this.#applyErrors++;
    }
  }

  #sweep(): void {
    const now = this.#opts.monotonic();
    for (const entry of [...this.#entries.values()]) {
      if (now < entry.expiresAt) continue;
      this.#entries.delete(entry.challengeId);
      entry.controller.abort();
    }
  }
}
