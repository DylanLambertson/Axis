// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";

/**
 * The project trust ticket's brand and state (docs/design/project-registration-and-trust.md §5.4). Only the two gate modules load
 * this file (an import rule in test/packages/imports.test.mjs and scripts/code-oss/stage-scan.mjs): `project-trust-gate.ts` mints,
 * `project-trust.ts` spends. Nothing else can construct a ticket or read its state.
 */
const STATE = new WeakMap<object, { readonly projectId: string; readonly workspaceId: string | undefined; readonly at: number; spent: boolean }>();

/** The key only this module holds: no other code can construct a ticket. */
const MINT: unique symbol = Symbol("project-trust-ticket");

/** Minted only by `ProjectTrustGate.admit`; the brand is the private field (a structural copy is refused). */
export class ProjectTrustTicket {
  readonly #brand = true;
  constructor(key: typeof MINT) {
    if (key !== MINT) throw new AxisError("E_POLICY_DENIED", "The project is not trusted", { reason: "untrusted" });
  }
  static isTicket(v: unknown): v is ProjectTrustTicket {
    return typeof v === "object" && v !== null && #brand in v;
  }
}

export function mintTicket(projectId: string, workspaceId: string | undefined, at: number): ProjectTrustTicket {
  const t = new ProjectTrustTicket(MINT);
  STATE.set(t, { projectId, workspaceId, at, spent: false });
  return t;
}

/** Spends a ticket for this scope: false when it is not a ticket, already spent, stale, from the future or for another scope. */
export function spendTicket(ticket: unknown, scope: { readonly projectId: string; readonly workspaceId?: string }, now: () => number, ttlMs: number): boolean {
  const s = ProjectTrustTicket.isTicket(ticket) ? STATE.get(ticket) : undefined;
  if (s === undefined || s.spent) return false;
  s.spent = true;
  return !(now() - s.at > ttlMs || s.at > now() || s.projectId !== scope.projectId || s.workspaceId !== scope.workspaceId);
}
