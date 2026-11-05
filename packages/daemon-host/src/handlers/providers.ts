// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError, type Handler, type HandlerContext } from "@axis/daemon";
import { MAX_PROVIDERS, providersListResponseSchema, type ProviderInfo } from "@axis/protocol";
import type { GuardedProvider } from "@axis/providers";

/**
 * `axis.providers/1.list` (design section 4.2): read only, tier 0, no network request.
 *
 * It answers from the descriptors of the guarded providers, copying exactly the fields the contract names. A
 * descriptor is data an adapter produced, so nothing else on it (a label, a credential, a stray property) is ever
 * copied, and every error is built from the fixed messages below, never from the request, a descriptor or a caught
 * error. The daemon has already checked the request against the contract (strict, design section 4.3), so the
 * handler does not parse it again; it does check its own answer with the protocol schema, so an answer that fails
 * it is an internal error, not a partial list. Errors are `DaemonError`, the only class the daemon turns into a
 * wire code and message (anything else reaches the client as an opaque `E_INTERNAL`).
 */
export interface ProvidersHandlerDeps {
  /** The registered providers, read on every call so a later registration shows up. */
  readonly providers: () => readonly Pick<GuardedProvider, "descriptor">[];
}

const fail = (code: "E_CANCELLED" | "E_INTERNAL", message: string): never => {
  throw new DaemonError(code, message);
};

function infoOf(provider: Pick<GuardedProvider, "descriptor">): ProviderInfo {
  const d = provider.descriptor;
  const origin = d.destination.origin;
  return {
    providerId: d.providerId,
    displayName: d.displayName,
    apiVersion: d.apiVersion,
    connectionId: d.connectionId,
    destination: origin === undefined ? { description: d.destination.description } : { origin, description: d.destination.description },
  };
}

export function createProvidersListHandler(deps: ProvidersHandlerDeps): Handler {
  return (context: HandlerContext) => {
    if (context.signal.aborted) return fail("E_CANCELLED", "The request was cancelled.");
    let providers: ProviderInfo[];
    try {
      const sources = deps.providers();
      if (sources.length > MAX_PROVIDERS) return fail("E_INTERNAL", "The provider list is unavailable.");
      providers = sources
        .map(infoOf)
        .sort((a, b) => (a.connectionId < b.connectionId ? -1 : a.connectionId > b.connectionId ? 1 : 0));
    } catch {
      return fail("E_INTERNAL", "The provider list is unavailable.");
    }
    const answer = providersListResponseSchema.safeParse({ providers });
    if (!answer.success) return fail("E_INTERNAL", "The provider list is unavailable.");
    return answer.data;
  };
}

/** The handlers of this contract by method name, as the registry assembly (design section 4) expects them. */
export function createProvidersHandlers(deps: ProvidersHandlerDeps): { readonly list: Handler } {
  return { list: createProvidersListHandler(deps) };
}
