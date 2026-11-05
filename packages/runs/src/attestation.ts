// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";

/** Held by `daemon-attestation.ts` and nothing else. It is deliberately not re-exported from the package root. */
export const MINT = Symbol("axis.runs.trustAttestation");

export interface AttestationFacts {
  readonly workspaceId: string;
  /** The source repository id the journal recorded for the workspace. */
  readonly projectId: string;
  /** Clock time at which main attested the trust. */
  readonly issuedAt: number;
}

const MAX_FUTURE_SKEW_MS = 2000;

/**
 * Main's statement that the worktree's source repository is trusted right now (threat model TRU-2). A renderer
 * claim never gates a run, so a plain `trusted: true` is not accepted anywhere: only the daemon's connection layer
 * can mint one (`@axis/runs/daemon-attestation`), from the window-verified call main attested. The `#` field is
 * the brand: a literal, a prototype lookalike and a `structuredClone` of a real one all lack it.
 *
 * It names a workspace and the project the journal recorded, it expires, and it is single use, so a revoked trust
 * cannot be replayed from an old attestation.
 */
export class TrustAttestation {
  readonly #facts: AttestationFacts;
  #used = false;

  constructor(mint: symbol, facts: AttestationFacts) {
    if (mint !== MINT) throw new AxisError("E_POLICY_DENIED", "A trust attestation can only be minted by the daemon");
    this.#facts = Object.freeze({ ...facts });
  }

  static is(value: unknown): value is TrustAttestation {
    return typeof value === "object" && value !== null && #facts in value;
  }

  /**
   * Why `value` is not acceptable for this workspace now, or undefined when it is. With `consume` it is also
   * spent: it is a single check-and-use, so two concurrent starts cannot both pass on one attestation.
   */
  static check(
    value: unknown,
    expected: { readonly workspaceId: string; readonly projectId: string | undefined; readonly now: number; readonly ttlMs: number },
    consume: boolean,
  ): string | undefined {
    if (!TrustAttestation.is(value)) return "NOT_ATTESTED";
    const f = value.#facts;
    if (value.#used) return "ATTESTATION_USED";
    if (f.workspaceId !== expected.workspaceId) return "ATTESTATION_MISMATCH";
    if (expected.projectId !== undefined && f.projectId !== expected.projectId) return "ATTESTATION_MISMATCH";
    const age = expected.now - f.issuedAt;
    if (!Number.isFinite(age) || age > expected.ttlMs || age < -MAX_FUTURE_SKEW_MS) return "ATTESTATION_EXPIRED";
    if (consume) value.#used = true;
    return undefined;
  }

  /** True while it is unused and young enough; does not spend it. For the re-check just before spawn. */
  static fresh(value: unknown, now: number, ttlMs: number): boolean {
    if (!TrustAttestation.is(value)) return false;
    const age = now - value.#facts.issuedAt;
    return Number.isFinite(age) && age <= ttlMs && age >= -MAX_FUTURE_SKEW_MS;
  }
}
