// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";

/** Held by `daemon-principal.ts` and nothing else. It is deliberately not re-exported from the package root. */
export const MINT = Symbol("axis.journal.userPrincipal");

/**
 * The user, as an unforgeable principal. Completing a run in review is the
 * person's act (threat model WT-5), so the journal does not accept the string
 * "user" for it: a handler that copied an actor out of a request payload could
 * pass that. Only the daemon's connection layer can mint one, from the attested
 * connection (`userPrincipal()` in `@axis/journal/daemon-principal`).
 *
 * The `#` field is the brand. A literal, `Object.create(UserPrincipal.prototype)`
 * and a `structuredClone` of a real one all lack it.
 */
export class UserPrincipal {
  readonly #actor = "user" as const;

  constructor(mint: symbol) {
    if (mint !== MINT) throw new AxisError("E_POLICY_DENIED", "A user principal can only be minted by the daemon");
  }

  get actor(): "user" {
    return this.#actor;
  }

  static is(value: unknown): value is UserPrincipal {
    return typeof value === "object" && value !== null && #actor in value;
  }
}
