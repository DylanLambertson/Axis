// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError, type Handler, type HandlerContext } from "@axis/daemon";
import { MAX_PROVIDERS, providerInfoSchema, providersListResponseSchema, type ProviderInfo } from "@axis/protocol";
import type { GuardedProvider } from "@axis/providers";

/**
 * `axis.providers/1.list` (design section 4.2): read only, tier 0. It asks each guarded provider for its model list
 * (`listModels`, bounded by the guard's timeouts and the request's signal), so an adapter that lists over the network
 * does so to the destination its own entry shows, and never to another one. A connection whose list fails, is not valid
 * or is too long is `unavailable` with no models, and the rest of the list is unaffected (C5, PRV-4: no silent fallback,
 * and one broken connection does not hide the others).
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
  readonly providers: () => readonly Pick<GuardedProvider, "descriptor" | "listModels">[];
}

const fail = (code: "E_CANCELLED" | "E_INTERNAL", message: string): never => {
  throw new DaemonError(code, message);
};

/** The connection's models, or none (`unavailable`): a failed, malformed or oversize listing never reaches the answer. */
async function modelsOf(provider: Pick<GuardedProvider, "listModels">, signal: AbortSignal): Promise<ProviderInfo["models"] | undefined> {
  try {
    const listed = await provider.listModels({ signal });
    // Exactly the contract's fields: a model entry is adapter data like a descriptor. The contract's own limits (200 entries, the id alphabet, no duplicates) are checked with the whole entry in `infoOf`.
    return listed.map((m) => (m.displayName === undefined ? { modelId: m.id } : { modelId: m.id, displayName: m.displayName }));
  } catch {
    return undefined;
  }
}

async function infoOf(provider: Pick<GuardedProvider, "descriptor" | "listModels">, signal: AbortSignal): Promise<ProviderInfo> {
  const d = provider.descriptor;
  const origin = d.destination.origin;
  const models = await modelsOf(provider, signal);
  const build = (m: ProviderInfo["models"] | undefined): ProviderInfo => ({
    providerId: d.providerId,
    displayName: d.displayName,
    apiVersion: d.apiVersion,
    connectionId: d.connectionId,
    status: m === undefined ? "unavailable" : "ready",
    models: m ?? [],
    destination: origin === undefined ? { description: d.destination.description } : { origin, description: d.destination.description },
  });
  const info = build(models);
  // A model list the contract refuses (an id outside its alphabet, a duplicate) makes this connection unavailable, not the whole list.
  return models !== undefined && !providerInfoSchema.safeParse(info).success ? build(undefined) : info;
}

export function createProvidersListHandler(deps: ProvidersHandlerDeps): Handler {
  return async (context: HandlerContext) => {
    if (context.signal.aborted) return fail("E_CANCELLED", "The request was cancelled.");
    let providers: ProviderInfo[];
    try {
      const sources = deps.providers();
      if (sources.length > MAX_PROVIDERS) return fail("E_INTERNAL", "The provider list is unavailable.");
      providers = (await Promise.all(sources.map((p) => infoOf(p, context.signal))))
        .sort((a, b) => (a.connectionId < b.connectionId ? -1 : a.connectionId > b.connectionId ? 1 : 0));
    } catch {
      return fail("E_INTERNAL", "The provider list is unavailable.");
    }
    if (context.signal.aborted) return fail("E_CANCELLED", "The request was cancelled.");
    const answer = providersListResponseSchema.safeParse({ providers });
    if (!answer.success) return fail("E_INTERNAL", "The provider list is unavailable.");
    return answer.data;
  };
}

/** The handlers of this contract by method name, as the registry assembly (design section 4) expects them. */
export function createProvidersHandlers(deps: ProvidersHandlerDeps): { readonly list: Handler } {
  return { list: createProvidersListHandler(deps) };
}
