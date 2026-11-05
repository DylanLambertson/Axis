// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { ApprovalContentHook, Daemon, Handler } from "@axis/daemon";
import { AUDIT_CONTRACT, AUDIT_VERSION, lookupMethod } from "@axis/protocol";
import type { AnchorGuard } from "../anchor/manager.js";
import { createAuditHandlers, type AuditHandlerDeps } from "./audit.js";

/**
 * Refuse tier 3 and above while the audit anchor is stalled (design 5.4). The tier comes from the contract, never
 * from the caller. A method of tier 2 or below is returned untouched, so reads and ordinary writes keep working.
 *
 * Registration is structural: every handler goes through `createHandlerRegistrar(...).register`, which wraps each tier
 * 3 and above method itself, so a later ticket cannot forget the guard (the raw `Daemon.register` is not handed to
 * handler code). A handler that is already guarded is not wrapped twice.
 *
 * The tier is the contract's. That is the effective tier only because the coverage check (design 4.2.1) fails startup
 * when a policy rule tier differs from the contract tier; the gate adapter receives the effective `input.tier`.
 *
 * LIMIT, and a requirement on the approval gate adapter (ticket H5): this guard runs inside the handler, which the
 * daemon calls AFTER the approval step. A stalled host would therefore issue a challenge (and for tier 4 show a
 * native dialog) or spend an approval, and only then refuse. The gate adapter MUST call `anchors.check(tier)` before
 * it issues a challenge and before it consumes an approval, so a refused request neither asks nor burns anything.
 * This guard stays as defence in depth for a stall that begins between the spend and the handler.
 */
const GUARDED = new WeakSet<Handler>();

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
    if (tier < 3 || GUARDED.has(handler)) {
      out[method] = handler;
      continue;
    }
    const wrapped: Handler = (context, payload) => (guard.check(tier), handler(context, payload));
    GUARDED.add(wrapped);
    out[method] = wrapped;
  }
  return out;
}

/** The only way handler code registers: the daemon stays private, and tier 3 and above is always guarded. */
export interface HandlerRegistrar {
  register(
    contract: string,
    version: number,
    handlers: Readonly<Record<string, Handler>>,
    options?: { readonly content?: Readonly<Record<string, ApprovalContentHook>> },
  ): void;
}

export function createHandlerRegistrar(daemon: Pick<Daemon, "register">, guard: Pick<AnchorGuard, "check">): HandlerRegistrar {
  const registrar: HandlerRegistrar = {
    register(contract, version, handlers, options) {
      const guarded = guardHandlers(contract, version, handlers, guard);
      if (options === undefined) daemon.register(contract, version, guarded);
      else daemon.register(contract, version, guarded, options);
    },
  };
  return Object.freeze(registrar);
}

/** Register `axis.audit/1` (served in degraded mode too: the three methods are reads, tier 0 and 1). */
export function registerAuditHandlers(registrar: HandlerRegistrar, deps: AuditHandlerDeps): void {
  registrar.register(AUDIT_CONTRACT, AUDIT_VERSION, createAuditHandlers(deps));
}
