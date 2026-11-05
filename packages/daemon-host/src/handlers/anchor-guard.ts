// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Daemon, Handler } from "@axis/daemon";
import { AUDIT_CONTRACT, AUDIT_VERSION, lookupMethod } from "@axis/protocol";
import type { AnchorGuard } from "../anchor/manager.js";
import { createAuditHandlers, type AuditHandlerDeps } from "./audit.js";

/**
 * Refuse tier 3 and above while the audit anchor is stalled (design 5.4). The tier comes from the contract, never
 * from the caller. A method of tier 2 or below is returned untouched, so reads and ordinary writes keep working.
 *
 * This runs inside the handler, after the daemon's approval step. The approval gate adapter (ticket H5) calls
 * `guard.check(tier)` before it issues or spends a challenge, so a refused request does not use one up.
 */
export function guardHandlers(
  contract: string,
  version: number,
  handlers: Readonly<Record<string, Handler>>,
  guard: Pick<AnchorGuard, "check">,
): Record<string, Handler> {
  const out: Record<string, Handler> = {};
  for (const [method, handler] of Object.entries(handlers)) {
    const spec = lookupMethod(contract, version, method);
    if (spec === undefined) throw new Error(`No such method ${contract}/${version}.${method}`);
    const tier = spec.tier;
    out[method] = tier < 3 ? handler : (context, payload) => (guard.check(tier), handler(context, payload));
  }
  return out;
}

/** Register `axis.audit/1` on the daemon. Served in degraded mode too (the three methods are reads, tier 0 and 1). */
export function registerAuditHandlers(daemon: Pick<Daemon, "register">, deps: AuditHandlerDeps & { readonly anchors: AnchorGuard }): void {
  daemon.register(AUDIT_CONTRACT, AUDIT_VERSION, guardHandlers(AUDIT_CONTRACT, AUDIT_VERSION, createAuditHandlers(deps), deps.anchors));
}
