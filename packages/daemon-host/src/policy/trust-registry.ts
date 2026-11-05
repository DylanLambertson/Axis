// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { TrustRegistry, TrustSubject } from "../ports/trust.js";

/** Bound on remembered decisions. */
export const MAX_TRUST_ENTRIES = 4096;

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
export class InMemoryTrustRegistry implements TrustRegistry {
  readonly #entries = new Map<string, boolean>();
  #saturated = false;

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
    if (this.#saturated) throw new RangeError("trust registry is saturated");
    const keys = levels(subject);
    if (keys === null || typeof trusted !== "boolean") throw new RangeError("invalid trust subject");
    const key = keys[keys.length - 1] as string;
    if (!this.#entries.has(key) && this.#entries.size >= MAX_TRUST_ENTRIES) {
      if (!trusted) this.#saturated = true;
      throw new RangeError(trusted ? "trust registry is full" : "trust registry is saturated");
    }
    this.#entries.set(key, trusted);
  }
}
