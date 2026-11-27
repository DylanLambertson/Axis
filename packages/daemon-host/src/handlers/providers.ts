// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError, type Handler, type HandlerContext } from "@axis/daemon";
import { MAX_PROVIDERS, providerCredentialSchema, providerInfoSchema, providersListResponseSchema, sanitizeDestinationText, type ProviderCredential, type ProviderInfo } from "@axis/protocol";
import type { GuardedProvider } from "@axis/providers";

/**
 * `axis.providers/1.list` (design section 4.2): read only, tier 0, and it sends no request to a network destination. An
 * adapter that makes no request (no `origin`) is asked for its models live, each within its own time limit; one that
 * does is listed from `cachedModels` (a list recorded through an approved path, C6) and is `unchecked` until there is one.
 * A connection whose list fails, is too slow, is not valid or is too long is `unavailable` with no models, and the rest
 * of the list is unaffected (C5, PRV-4: no silent fallback, and one broken connection does not hide the others).
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
  /** The last model list recorded for a connection through an approved path (C6); used for adapters that make network requests. */
  readonly cachedModels?: (connectionId: string) => Listed | undefined;
  /**
   * Where a connection's credential is stored (PRV-1, C6), from the vault: undefined for a connection that needs none. It
   * reads the local vault backend only, never the network; one that fails, is too slow or answers outside the contract
   * shows `unavailable`.
   */
  readonly credential?: (connectionId: string, signal: AbortSignal) => Promise<ProviderCredential | undefined>;
  /** The longest one connection may take to list (default 5000 ms); the others are listed all the same. */
  readonly listTimeoutMs?: number;
}

const DEFAULT_LIST_TIMEOUT_MS = 5_000;

const fail = (code: "E_CANCELLED" | "E_INTERNAL", message: string): never => {
  throw new DaemonError(code, message);
};

type Source = Pick<GuardedProvider, "descriptor" | "listModels">;
type Listed = readonly { readonly id: string; readonly displayName?: string }[];

/** `fn` given at most `timeoutMs` (its own signal is aborted at the limit); undefined when it fails or is too slow. */
async function within<T>(fn: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T | undefined> {
  const own = new AbortController();
  const stop = (): void => own.abort();
  signal.addEventListener("abort", stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const limit = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => (own.abort(), resolve(undefined)), timeoutMs);
    });
    const done = Promise.resolve()
      .then(() => fn(own.signal))
      .catch(() => undefined);
    return await Promise.race([done, limit]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}

/** The credential display of one connection: absent when it needs none, `unavailable` when the vault cannot answer in time. */
async function credentialOf(deps: ProvidersHandlerDeps, connectionId: string, signal: AbortSignal): Promise<ProviderCredential | undefined> {
  if (deps.credential === undefined) return undefined;
  let needsNone = false;
  const raw = await within(
    async (s) => {
      const c = await deps.credential?.(connectionId, s);
      if (c === undefined) needsNone = true;
      return c;
    },
    signal,
    deps.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS,
  );
  if (needsNone) return undefined;
  // Exactly the contract's fields, or `unavailable`: the answer is vault data, like a descriptor is adapter data.
  const parsed = providerCredentialSchema.safeParse(raw);
  return parsed.success ? parsed.data : { state: "unavailable" };
}

async function infoOf(provider: Source, deps: ProvidersHandlerDeps, signal: AbortSignal): Promise<ProviderInfo> {
  const d = provider.descriptor;
  const origin = d.destination.origin;
  const description = sanitizeDestinationText(d.destination.description);
  const credential = await credentialOf(deps, d.connectionId, signal);
  const build = (status: ProviderInfo["status"], models: ProviderInfo["models"]): ProviderInfo => ({
    providerId: d.providerId,
    displayName: d.displayName,
    apiVersion: d.apiVersion,
    connectionId: d.connectionId,
    status,
    models,
    destination: origin === undefined ? { description } : { origin, description },
    ...(credential === undefined ? {} : { credential }),
  });
  // An adapter that makes network requests is not asked here: a read-only list must not send an unapproved request per call
  // (C6 records a list through an approved path and passes it as `cachedModels`). One that makes no request is asked live.
  let listed: Listed | undefined;
  if (origin === undefined) listed = await within((s) => provider.listModels({ signal: s }), signal, deps.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS);
  else {
    listed = deps.cachedModels?.(d.connectionId);
    if (listed === undefined) return build("unchecked", []);
  }
  if (listed === undefined) return build("unavailable", []);
  // Exactly the contract's fields: a model entry is adapter data like a descriptor.
  const info = build("ready", listed.map((m) => (m.displayName === undefined ? { modelId: m.id } : { modelId: m.id, displayName: m.displayName })));
  // A model list the contract refuses (an id outside its alphabet, a duplicate, over 200) makes this connection unavailable, not the whole list.
  return providerInfoSchema.safeParse(info).success ? info : build("unavailable", []);
}

export function createProvidersListHandler(deps: ProvidersHandlerDeps): Handler {
  return async (context: HandlerContext) => {
    if (context.signal.aborted) return fail("E_CANCELLED", "The request was cancelled.");
    let providers: ProviderInfo[];
    try {
      const sources = deps.providers();
      if (sources.length > MAX_PROVIDERS) return fail("E_INTERNAL", "The provider list is unavailable.");
      providers = (await Promise.all(sources.map((p) => infoOf(p, deps, context.signal))))
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
