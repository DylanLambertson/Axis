// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson, identitySchema, type Identity, type IdentityVerifier } from "@axis/daemon";
import type { JsonValue } from "@axis/protocol";
import type { Clock } from "../ports/clock.js";
import { attestationSchema, type Attestation } from "./messages.js";

/**
 * The attestation (design section 6.1): `{ identity, issuedAt, mac }` with
 * `mac = HMAC-SHA256(key, canonicalJson(["axis.attest/1", identity, issuedAt]))`. The MAC covers every identity
 * field, so the actor, the workspace, the window and the connection id are all bound; changing one invalidates it.
 * It is single use: a connection id seen within the freshness window is refused the second time.
 */

export const ATTESTATION_TAG = "axis.attest/1";
/** An attestation older than this is refused. */
export const MAX_AGE_MS = 30_000;
/** An attestation dated further ahead than this is refused (clock skew allowance). */
export const MAX_SKEW_MS = 5_000;
/** Connection ids remembered at once. A full ring of fresh ids refuses new attestations (fail closed). */
export const DEFAULT_RING_SIZE = 4_096;

export const REFUSAL_REASONS = ["malformed", "bad_mac", "stale", "future", "bad_identity", "replayed", "ring_full", "closed"] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

function macOf(key: Uint8Array, identity: unknown, issuedAt: number): Buffer {
  const text = canonicalJson([ATTESTATION_TAG, identity as JsonValue, issuedAt]);
  return createHmac("sha256", key).update(text, "utf8").digest();
}

/**
 * Mint an attestation. The supervisor does this in the product; the host only verifies. It lives here so the test
 * supervisor mints with the same code and the two cannot drift.
 */
export function signAttestation(key: Uint8Array, identity: Identity, issuedAt: number): Attestation {
  return { identity: { ...identity } as Attestation["identity"], issuedAt, mac: macOf(key, identity, issuedAt).toString("base64url") };
}

export interface AttestationVerifierOptions {
  readonly key: Uint8Array;
  readonly clock: Clock;
  readonly ringSize?: number;
}

export interface AttestationVerifier extends IdentityVerifier {
  verify(attestation: unknown): Identity | undefined;
  /** Why attestations were refused, by closed reason. No value from an attestation is ever kept. */
  readonly refusals: () => Readonly<Record<RefusalReason, number>>;
  /** Forget the key (zeroed) and every remembered id. Later `verify` calls refuse. */
  close(): void;
}

export function createAttestationVerifier(options: AttestationVerifierOptions): AttestationVerifier {
  const key = new Uint8Array(options.key);
  const ringSize = options.ringSize ?? DEFAULT_RING_SIZE;
  const { clock } = options;
  /** connectionId -> time after which the id can no longer be replayed (its attestation is stale by then). */
  const seen = new Map<string, number>();
  const counts = Object.fromEntries(REFUSAL_REASONS.map((r) => [r, 0])) as Record<RefusalReason, number>;
  let closed = false;

  const refuse = (reason: RefusalReason): undefined => {
    counts[reason]++;
    return undefined;
  };

  return {
    verify(raw: unknown): Identity | undefined {
      if (closed) return refuse("closed");
      const parsed = attestationSchema.safeParse(raw);
      if (!parsed.success) return refuse("malformed");
      const { identity, issuedAt, mac } = parsed.data;
      const given = Buffer.from(mac, "base64url");
      const expected = macOf(key, identity, issuedAt);
      // The schema fixes the text at 43 characters (32 bytes); the length is still checked before the compare.
      if (given.length !== expected.length || given.toString("base64url") !== mac || !timingSafeEqual(given, expected)) {
        return refuse("bad_mac");
      }
      const now = clock.now();
      if (now - issuedAt > MAX_AGE_MS) return refuse("stale");
      if (issuedAt > now + MAX_SKEW_MS) return refuse("future");
      const checked = identitySchema.safeParse(identity);
      if (!checked.success) return refuse("bad_identity");
      const result = checked.data as Identity;
      for (const [id, until] of seen) if (until < now) seen.delete(id);
      if (seen.has(result.connectionId)) return refuse("replayed");
      if (seen.size >= ringSize) return refuse("ring_full");
      seen.set(result.connectionId, issuedAt + MAX_AGE_MS);
      return result;
    },
    refusals: () => Object.freeze({ ...counts }),
    close(): void {
      closed = true;
      key.fill(0);
      seen.clear();
    },
  };
}
