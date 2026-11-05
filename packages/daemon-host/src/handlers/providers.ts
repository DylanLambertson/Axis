// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import type { Handler, HandlerContext } from "@axis/daemon";
import { providersListRequestSchema, providersListResponseSchema, type ProviderInfo } from "@axis/protocol";
import type { GuardedProvider } from "@axis/providers";

/**
 * `axis.providers/1.list` (design section 4.2): read only, tier 0, no network request.
 *
 * It answers from the descriptors of the guarded providers, copying exactly the fields the contract names. A
 * descriptor is data an adapter produced, so nothing else on it (a label, a credential, a stray property) is ever
 * copied, and every error is built from the fixed messages below, never from the request, a descriptor or a caught
 * error. The request and the answer are both checked with the protocol's schemas; an answer that fails its own
 * schema is an internal error, not a partial list.
 */
export interface ProvidersHandlerDeps {
  /** The registered providers, read on every call so a later registration shows up. */
  readonly providers: () => readonly Pick<GuardedProvider, "descriptor">[];
}

const fail = (code: "E_INVALID_ARGUMENT" | "E_CANCELLED" | "E_INTERNAL", message: string): never => {
  throw new AxisError(code, message);
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
  return (context: HandlerContext, payload: unknown) => {
    if (context.signal.aborted) return fail("E_CANCELLED", "The request was cancelled.");
    if (!providersListRequestSchema.safeParse(payload).success) return fail("E_INVALID_ARGUMENT", "The request is not valid.");
    let providers: ProviderInfo[];
    try {
      providers = deps
        .providers()
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
