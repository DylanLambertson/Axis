// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { AuditSink, Redactor } from "@axis/audit";
import { createAnthropicAdapter, type AnthropicLimits, type FetchLike, type KeyPurpose, type Pricing } from "@axis/anthropic";
import type { ProviderCredential } from "@axis/protocol";
import { ProviderError, guardProvider, type GenerateRequest, type GenerateResult, type GuardLimits, type GuardedProvider, type ModelInfo, type Redactor as ProviderRedactor, type RunOptions, type StreamEvent } from "@axis/providers";
import { VaultError, createVault, type ConnectionVault, type SecretBackend } from "@axis/vault";

export type { FetchLike, Pricing, SecretBackend };

/**
 * The network providers and the connection vault (docs/design/composer-runtime.md ticket C6). This is the ONLY file that
 * imports `@axis/anthropic` and `@axis/vault` (`daemon-host.md` 2.1; `test/packages/imports.test.mjs`, and the staging
 * scan's `RESTRICTED_MODULES`). It hands the agent binding guarded providers and nothing of the vault.
 *
 * - **The key (PRV-2).** Read from the vault once per provider request, immediately before it (the adapter's `apiKey`), and
 *   never kept by this binding, a run row, an event or an error. It is registered with the host redactor before the adapter
 *   sees it, so an echo of it anywhere the host writes (logs, audit, stored activity, errors) is redacted. A vault that is
 *   locked, failing or has no key fails the request closed (`authentication`, `no_credential`; the run ends
 *   `PROVIDER_AUTHENTICATION`); there is no other source of a key and no fallback provider (PRV-4).
 * - **Audit (DMN-5).** Every read is a `provider.credential` row (purpose and outcome, never the key). A read whose row
 *   cannot be written is refused: the key is never used unaudited.
 * - **The response.** It must be from the model asked for (a `message_start` or result naming another fails
 *   `invalid_response` / `model_mismatch`), and it must not hold a key the vault has handed out (`credential_echo`): an
 *   echo would reach the live activity, a tool call or a file. Usage is settled by the guard before these checks, so the
 *   run budget counts the request either way.
 * - **Model list (C5 SF-1).** `axis.providers/1.list` never asks a network adapter; the list a run start fetched (the start
 *   is the approved path) is recorded here and shown until the next start fetches it again. A failed fetch clears it.
 * - **PRV-1.** `credential()` shows where the key is stored and whether a store would be allowed, from the local backend.
 */

export interface AnthropicConnectionOptions {
  /** The vault connection name the key is stored under (`NAME_RE`). */
  readonly connectionId: string;
  /** The OS-backed secret storage (the main process's secret broker, ADR 0003 D1.6). Tests pass a fake. */
  readonly backend: SecretBackend;
  /** Default: Node's global `fetch`. Tests pass one that reaches a local mock server. */
  readonly fetch?: FetchLike;
  readonly pricing?: (model: string) => Pricing | undefined;
  /** Wire caps (`@axis/anthropic` `DEFAULT_LIMITS`): body, event and line bytes, event counts, JSON depth. */
  readonly limits?: Partial<AnthropicLimits>;
  /** The guard's request and idle timeouts and stream limits (`@axis/providers` defaults). */
  readonly guardLimits?: GuardLimits;
}

export interface ProvidersBindingDeps {
  /** The host's redactor: every key read is registered with it before use. */
  readonly redactor: Redactor;
  readonly audit: AuditSink;
  readonly anthropic?: AnthropicConnectionOptions;
}

export interface ProvidersBinding {
  /** The network providers, guarded (none without a connection). */
  readonly providers: readonly GuardedProvider[];
  /** The model list a run start last fetched for a connection (C5 `cachedModels`). */
  cachedModels(connectionId: string): readonly ModelInfo[] | undefined;
  /** Where a connection's key is stored (PRV-1); undefined for a connection this binding does not hold. */
  credential(connectionId: string, signal: AbortSignal): Promise<ProviderCredential | undefined>;
}

/** Audit payload keys of the vault reads (DMN-5): why the key was read and what came of it. Never the key. */
export const PROVIDERS_PAYLOAD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze({ "provider.credential": Object.freeze(["purpose", "outcome"]) });

/** The host's audit redactor as the providers' redaction hook (PRV-2): anything it would change counts as a secret. */
export function providerRedactor(r: Redactor): ProviderRedactor {
  return { redact: (t) => r.redactString(t), containsSecret: (t) => r.redactString(t) !== t };
}

const nodeFetch: FetchLike = (url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>;

/** The longest key the vault stores: a stream is checked over a window this long, so a key split across deltas is still found. */
const KEY_WINDOW = 4096;

/**
 * A guarded provider whose answers must come from the model asked for and must not carry a key the vault handed out.
 * The guard has already settled the request's usage, so a refused answer is still counted by the budget.
 */
function pinned(g: GuardedProvider, leaks: (text: string) => boolean, onModels: (models: readonly ModelInfo[] | undefined) => void): GuardedProvider {
  const mismatch = (): ProviderError => new ProviderError("invalid_response", { reason: "model_mismatch" });
  const echo = (): ProviderError => new ProviderError("invalid_response", { reason: "credential_echo" });
  const checkResult = (request: GenerateRequest, result: GenerateResult): GenerateResult => {
    if (result.model !== request.model) throw mismatch();
    for (const block of result.content) {
      const text = block.type === "text" ? block.text : `${block.name} ${JSON.stringify(block.input)}`;
      if (leaks(text)) throw echo();
    }
    return result;
  };
  const out: GuardedProvider = {
    descriptor: g.descriptor,
    async listModels(opts) {
      try {
        const models = await g.listModels(opts);
        onModels(models);
        return models;
      } catch (e) {
        onModels(undefined);
        throw e;
      }
    },
    getCapabilities: (model, opts) => g.getCapabilities(model, opts),
    validateConnection: (opts) => g.validateConnection(opts),
    countTokens: (request, run) => g.countTokens(request, run),
    generate: async (request: GenerateRequest, run: RunOptions) => checkResult(request, await g.generate(request, run)),
    stream(request: GenerateRequest, run: RunOptions): AsyncIterable<StreamEvent> {
      return {
        async *[Symbol.asyncIterator]() {
          const tails = new Map<number, string>();
          for await (const ev of g.stream(request, run)) {
            if (ev.type === "message_start" && ev.model !== request.model) throw mismatch();
            if (ev.type === "content_block_delta") {
              const window = (tails.get(ev.index) ?? "") + (ev.delta.type === "text" ? ev.delta.text : ev.delta.partialJson);
              if (leaks(window)) throw echo();
              tails.set(ev.index, window.slice(-KEY_WINDOW));
            }
            yield ev;
          }
        },
      };
    },
  };
  return Object.freeze(out);
}

export function createProvidersBinding(deps: ProvidersBindingDeps): ProvidersBinding {
  const conn = deps.anthropic;
  if (conn === undefined) return { providers: [], cachedModels: () => undefined, credential: async () => undefined };
  const connectionId = conn.connectionId;
  const vault: ConnectionVault = createVault({ backend: conn.backend, weakPolicy: "consent" });
  const target = `connection:${connectionId}`;

  const audited = (purpose: KeyPurpose, outcome: string): void => {
    deps.audit.append({ actor: "daemon", action: "provider.credential", target, outcome: outcome === "ok" ? "success" : "failure", payload: { purpose, outcome } });
  };

  /** One key read for one request. Throws a fixed error (the adapter makes it `no_credential`); never keeps the key. */
  const apiKey = async (purpose: KeyPurpose): Promise<string> => {
    let key: string;
    try {
      key = await vault.reveal(connectionId, purpose);
    } catch (e) {
      try {
        audited(purpose, e instanceof VaultError ? e.code : "backend_failed");
      } catch {
        // The read failed anyway; the request is refused below.
      }
      throw new Error("credential unavailable");
    }
    // Registered before the adapter sees it, so an echo anywhere the host writes is redacted; a key the redactor
    // refuses (too short) is not used. The audit row comes before any use: a read that cannot be recorded is refused.
    deps.redactor.registerSecret(key);
    audited(purpose, "ok");
    return key;
  };

  const adapter = createAnthropicAdapter({
    connectionId,
    apiKey,
    fetch: conn.fetch ?? nodeFetch,
    ...(conn.pricing === undefined ? {} : { pricing: conn.pricing }),
    ...(conn.limits === undefined ? {} : { limits: conn.limits }),
  });
  let models: readonly ModelInfo[] | undefined;
  const leaks = (text: string): boolean => vault.knownSecrets().some((s) => text.includes(s));
  const guarded = guardProvider(adapter, { redactor: providerRedactor(deps.redactor), ...(conn.guardLimits === undefined ? {} : { limits: conn.guardLimits }) });
  const provider = pinned(guarded, leaks, (m) => (models = m));

  return {
    providers: [provider],
    cachedModels: (id) => (id === connectionId ? models : undefined),
    async credential(id) {
      if (id !== connectionId) return undefined;
      try {
        const stored = await vault.info(connectionId);
        if (stored !== undefined) {
          return { state: "stored", backend: stored.backend, protection: stored.protection, weakConsent: stored.weakConsent, backendChanged: stored.backendChanged };
        }
        const b = await vault.backend();
        return { state: "missing", backend: b.id, protection: b.protection, policy: b.policy };
      } catch {
        return { state: "unavailable" };
      }
    },
  };
}
