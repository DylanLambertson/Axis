// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * How a method is gated on trust.
 * - `none`: no trust condition.
 * - `registry`: the attested `identity.trusted` AND the live `TrustRegistry` must both say trusted (design 6.2).
 * - `per-start`: a CLI run start. Trust is a single-use attestation minted per call from the supervisor's live answer
 *   (TRU-2), so the registry is not the authority, but an explicit revoke in it refuses the start as well.
 */
export type TrustMode = "none" | "registry" | "per-start";

/** The actors a rule admits. In Phase 1a only `user` connects; an `agent:*` or `daemon` identity is refused everywhere. */
export type RuleActor = "user";

export interface Rule {
  /** The tier the host requires. The daemon takes the larger of this and the contract's minimum; it can never lower it. */
  readonly tier: 0 | 1 | 2 | 3 | 4 | 5;
  readonly actors: readonly RuleActor[];
  readonly trust: TrustMode;
}

/** The table key of a method: `<contract id>/<major>.<method>`, e.g. `axis.worktrees/1.create`. */
export function ruleKey(contract: string, version: number, method: string): string {
  return `${contract}/${version}.${method}`;
}

/** A user-only rule. Every Phase 1a row is one; a later broker row would add its own helper rather than widen this. */
export function userRule(tier: Rule["tier"], trust: TrustMode = "none"): Rule {
  return Object.freeze({ tier, actors: Object.freeze(["user"] as const), trust });
}
