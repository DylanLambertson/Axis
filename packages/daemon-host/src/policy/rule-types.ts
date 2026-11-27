// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * How a method is gated on trust (docs/design/project-registration-and-trust.md §5.4).
 * - `none`: no trust condition.
 * - `project`: the project trust gate decides, inside the handler right before the side effect (T1 to T4: the main-confirmed
 *   record, its binding, the worktree's binding, main's `trust.check`, no revoke), and the side-effect port requires the ticket
 *   it mints. Policy refuses only a recorded revoke here, at dispatch.
 * - `per-start`: a CLI run start: the same gate, then the single-use `TrustAttestation` (TRU-2). Same policy check.
 * Policy never reads the attested `identity.trusted` (the connect-time reading of the renderer-writable model).
 */
export type TrustMode = "none" | "project" | "per-start";

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
