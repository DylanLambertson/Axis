// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { NAME_RE } from "./names.js";
import { BACKEND_IDS, type BackendId } from "./types.js";

/**
 * The user's consent to store one connection's credential on one backend that
 * gives no protection (PRV-1). An opaque, frozen object that only a
 * `ConsentGrantor` can create; it is useless to any vault that does not trust
 * that grantor's verifier.
 */
export interface WeakStorageConsent {
  readonly connectionId: string;
  readonly backend: BackendId;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

/**
 * Held by the approvals path only: it calls `grant` after the user resolves a
 * native confirmation that names the connection and the backend (DMN-3: an
 * agent cannot resolve it). There is no free-standing factory, so code that was
 * not given the grantor cannot mint a consent.
 */
export interface ConsentGrantor {
  grant(input: { readonly connectionId: string; readonly backend: BackendId }): WeakStorageConsent;
}

/** Handed to the vault. `redeem` checks and spends in one synchronous step. */
export interface ConsentVerifier {
  redeem(consent: unknown, want: { readonly connectionId: string; readonly backend: BackendId }): boolean;
}

export interface ConsentAuthorityOptions {
  /** How long a consent stays valid. Default five minutes. */
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export const DEFAULT_CONSENT_TTL_MS = 300_000;

const BACKEND_SET: ReadonlySet<string> = new Set(BACKEND_IDS);

/**
 * One authority per daemon: its grantor goes to the approvals service and its
 * verifier to every vault. Each consent is single use across all vaults that
 * share the verifier, bound to a connection id and a backend id, and expires.
 * Spending is synchronous, so concurrent stores cannot both pass (S2).
 */
export function createConsentAuthority(options: ConsentAuthorityOptions = {}): { readonly grantor: ConsentGrantor; readonly verifier: ConsentVerifier } {
  const ttl = options.ttlMs ?? DEFAULT_CONSENT_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 1) throw new RangeError("ttlMs must be a positive safe integer");
  const now = options.now ?? ((): number => Date.now());
  const issued = new WeakMap<object, { spent: boolean }>();

  const grantor: ConsentGrantor = {
    grant(input) {
      if (typeof input?.connectionId !== "string" || !NAME_RE.test(input.connectionId)) throw new RangeError("invalid connection id");
      if (typeof input.backend !== "string" || !BACKEND_SET.has(input.backend)) throw new RangeError("invalid backend id");
      const consent: WeakStorageConsent = Object.freeze({ connectionId: input.connectionId, backend: input.backend, expiresAt: now() + ttl });
      issued.set(consent, { spent: false });
      return consent;
    },
  };

  const verifier: ConsentVerifier = {
    redeem(consent, want) {
      if (typeof consent !== "object" || consent === null) return false;
      const record = issued.get(consent);
      if (record === undefined || record.spent) return false;
      const c = consent as WeakStorageConsent;
      if (c.connectionId !== want.connectionId || c.backend !== want.backend || now() >= c.expiresAt) return false;
      record.spent = true;
      return true;
    },
  };
  return Object.freeze({ grantor: Object.freeze(grantor), verifier: Object.freeze(verifier) });
}
