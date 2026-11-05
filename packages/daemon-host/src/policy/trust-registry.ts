// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { TrustRegistry, TrustSubject } from "../ports/trust.js";

/** Bound on remembered decisions. Trust is never granted past it; a revoke always lands. */
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
  if (s.projectId !== undefined) {
    if (!valid(s.projectId)) return null;
    out.push(`p:${s.projectId}`);
  }
  return out;
}

/**
 * Live trust, held in memory and fed only by supervisor control messages (`trust.set`; design 6.2). A decision is
 * recorded at the most specific level the subject names (project, else workspace, else window). A subject is trusted
 * only if some level says trusted and NO level says revoked, so a revoke at any level wins and an unknown subject is
 * untrusted. A workspace or project decision holds in every window (a revoke must not be escapable by opening
 * another window); a bare window with no decision is untrusted. Revoking never touches a running run (Q6): nothing here holds a reference to the run supervisor.
 */
export class InMemoryTrustRegistry implements TrustRegistry {
  readonly #entries = new Map<string, boolean>();

  isTrusted(subject: TrustSubject): boolean {
    const keys = levels(subject);
    if (keys === null) return false;
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
    // A malformed subject cannot be shown to be fine, so it counts as revoked (fail closed).
    if (keys === null) return true;
    return keys.some((k) => this.#entries.get(k) === false);
  }

  set(subject: TrustSubject, trusted: boolean): void {
    const keys = levels(subject);
    if (keys === null || typeof trusted !== "boolean") throw new RangeError("invalid trust subject");
    const key = keys[keys.length - 1] as string;
    if (!this.#entries.has(key) && this.#entries.size >= MAX_TRUST_ENTRIES) {
      if (trusted) throw new RangeError("trust registry is full");
      this.#evict();
    }
    // Re-insert so the map stays in order of last update (oldest first for eviction).
    this.#entries.delete(key);
    this.#entries.set(key, trusted);
  }

  /** Make room for a revoke: drop the oldest grant (fail-closed direction), else the oldest revoke. */
  #evict(): void {
    for (const [k, v] of this.#entries) {
      if (v) return void this.#entries.delete(k);
    }
    const first = this.#entries.keys().next();
    if (!first.done) this.#entries.delete(first.value);
  }
}
