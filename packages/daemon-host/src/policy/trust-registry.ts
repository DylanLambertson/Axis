// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { TrustRegistry, TrustRevocation, TrustRevocationSource, TrustSubject } from "../ports/trust.js";

/** Bound on remembered decisions. */
export const MAX_TRUST_ENTRIES = 4096;
/** Revokes a listener may queue during one dispatch (review nit 1); past it the registry latches saturated. */
export const MAX_QUEUED_REVOKES = 32;

const ID = /^[A-Za-z0-9._:-]{1,64}$/;

function valid(id: unknown): id is string {
  return typeof id === "string" && ID.test(id);
}

/** The levels a subject names, most general first. Null when any named id is malformed (treated as untrusted). */
function levels(s: TrustSubject): string[] | null {
  if (typeof s !== "object" || s === null || !valid(s.windowId)) return null;
  const out = [`w:${s.windowId}`];
  if (s.workspaceId !== undefined) {
    if (!valid(s.workspaceId)) return null;
    out.push(`s:${s.workspaceId}`);
  }
  return out;
}

/**
 * Live trust, held in memory and fed only by supervisor control messages (`trust.set`; design 6.2). A decision is
 * recorded at the most specific level the subject names (workspace, else window). A subject is trusted only if some
 * level says trusted and NO level says revoked, so a revoke at either level wins and an unknown subject is untrusted.
 *
 * Deliberate deviation from design 6.2 ("the default for an unknown window is untrusted"): a workspace decision is
 * keyed by the workspace alone and holds in every window, because trust belongs to the source repository and a
 * revoke must not be escapable by opening another window. A bare window with no decision is still untrusted, and a
 * grant is still ANDed with the per-connection attested `identity.trusted`.
 *
 * Bounded and fail closed: nothing is ever evicted. When the table is full, a new grant is refused, and a new revoke
 * (which cannot be recorded) latches the registry saturated: every subject is then untrusted and revoked and every
 * `set` throws, until the host restarts. Revoking never touches a running run (Q6): nothing here holds a run.
 */
export class InMemoryTrustRegistry implements TrustRegistry, TrustRevocationSource {
  readonly #entries = new Map<string, boolean>();
  #saturated = false;
  /** DC-3c: the revocation listeners, in registration order; `live` is cleared by the disposer. */
  #listeners: Array<{ readonly fn: (r: TrustRevocation) => void; live: boolean }> = [];
  #dispatching = false;
  /** Revokes asked for during a dispatch: recorded and dispatched right after it, in order (review nit 1). Bounded. */
  #queued: TrustSubject[] = [];
  #overflowed = false;
  readonly #onListenerError: (() => void) | undefined;

  constructor(options: { readonly onListenerError?: () => void } = {}) {
    this.#onListenerError = options.onListenerError;
  }

  /**
   * DC-3c (terminal-trust-revocation.md section 2): told synchronously after each recorded revoke, at its level, and `all` when a
   * revoke latches saturation. A listener may only make bounded synchronous authority changes, and never calls `set` (refused).
   */
  onRevoked(listener: (revocation: TrustRevocation) => void): { dispose(): void } {
    const entry = { fn: listener, live: true };
    this.#listeners = [...this.#listeners, entry];
    return {
      dispose: () => {
        if (!entry.live) return;
        entry.live = false;
        this.#listeners = this.#listeners.filter((e) => e !== entry);
      },
    };
  }

  /**
   * A snapshot of the listeners at the start; one disposed before its turn is skipped; each throw is caught on its own. Then the
   * revokes queued during it are recorded and dispatched, each in its own turn (a queued one may queue more, within the bound).
   */
  #notify(revocation: TrustRevocation): void {
    const snapshot = this.#listeners;
    this.#dispatching = true;
    try {
      for (const e of snapshot) {
        if (!e.live) continue;
        try {
          e.fn(revocation);
        } catch {
          this.#onListenerError?.();
        }
      }
    } finally {
      this.#dispatching = false;
    }
    while (this.#queued.length > 0 && !this.#saturated) {
      const next = this.#queued.shift() as TrustSubject;
      try {
        this.set(next, false);
      } catch {
        /* a full table latches saturation inside set, which notifies all */
      }
    }
    this.#queued = [];
    if (this.#overflowed) {
      this.#overflowed = false;
      this.#notify({ kind: "all" });
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  get saturated(): boolean {
    return this.#saturated;
  }

  isTrusted(subject: TrustSubject): boolean {
    const keys = levels(subject);
    if (keys === null || this.#saturated) return false;
    let granted = false;
    for (const k of keys) {
      const v = this.#entries.get(k);
      if (v === false) return false;
      if (v === true) granted = true;
    }
    return granted;
  }

  isRevoked(subject: TrustSubject): boolean {
    const keys = levels(subject);
    // A malformed subject cannot be shown to be fine, and a saturated registry has lost track, so both count as revoked.
    if (keys === null || this.#saturated) return true;
    return keys.some((k) => this.#entries.get(k) === false);
  }

  set(subject: TrustSubject, trusted: boolean): void {
    // DC-3c (review nit 1): while a revoke is being delivered, a GRANT is refused (it would overtake the revoke), and a REVOKE is
    // queued and recorded right after the dispatch, never dropped. Past the bound the registry latches saturated: fail closed.
    if (this.#dispatching) {
      if (trusted !== false) throw new RangeError("trust registry is notifying");
      if (levels(subject) === null) throw new RangeError("invalid trust subject");
      if (this.#queued.length >= MAX_QUEUED_REVOKES) {
        this.#saturated = true;
        this.#queued = [];
        this.#overflowed = true; // `all` is delivered right after this dispatch
        return;
      }
      this.#queued.push(subject);
      return;
    }
    if (this.#saturated) throw new RangeError("trust registry is saturated");
    const keys = levels(subject);
    if (keys === null || typeof trusted !== "boolean") throw new RangeError("invalid trust subject");
    const key = keys[keys.length - 1] as string;
    if (!this.#entries.has(key) && this.#entries.size >= MAX_TRUST_ENTRIES) {
      if (!trusted) {
        this.#saturated = true;
        this.#notify({ kind: "all" }); // the latch first, then the event, then the throw as before
      }
      throw new RangeError(trusted ? "trust registry is full" : "trust registry is saturated");
    }
    this.#entries.set(key, trusted);
    if (!trusted) this.#notify(subject.workspaceId === undefined ? { kind: "window", windowId: subject.windowId } : { kind: "subject", id: subject.workspaceId });
  }
}
