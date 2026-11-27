// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { VAULT_ERROR_CODES, VaultError, createVault, type SecretBackend, type VaultErrorCode } from "@axis/vault";
import { IntegrationRefusal, reasonIn, type IntegrationReason } from "../integrations/wire.js";

/**
 * The integrations binding over the connection vault (ADR 0009 decision 5; with the providers binding, the one host file that
 * may load `@axis/vault`). The service sees only `reveal` and `info` of integration entries, and only closed refusals: no vault
 * error, backend text or secret crosses. The vault refuses a store on a weak backend (`weakPolicy: "refuse"`, no consent path)
 * and, for an integration purpose, a reveal of an entry whose own metadata is weak or moved (`weak_entry`).
 */
export type { SecretBackend };

/** The vault's closed codes, re-exported for the mapping test (tests may not load the vault either). */
export const VAULT_CODES: readonly VaultErrorCode[] = VAULT_ERROR_CODES;

/** The vault on reveal: no entry is not connected, a weak or moved entry needs a new connection, the rest is internal. */
export const VAULT_REASON: Readonly<Record<VaultErrorCode, IntegrationReason>> = Object.freeze({
  not_found: "not_connected",
  weak_entry: "needs_reconnect",
  backend_changed: "needs_reconnect",
  backend_failed: "internal",
  consent_required: "internal",
  backend_refused: "internal",
  invalid_name: "internal",
  invalid_secret: "internal",
  wrong_entry_kind: "internal",
});

export interface IntegrationsVault {
  /** The token of `integration:<id>` for one request; a closed `IntegrationRefusal` otherwise. */
  reveal(entry: string): Promise<string>;
  /** The entry's metadata only (no decryption); `undefined` when there is none; `internal` when the backend fails. */
  info(entry: string): Promise<{ readonly protection: string; readonly backendChanged: boolean } | undefined>;
}

/** The vault over `backend`, or `undefined` with no backend (production until PV-N0c: nothing is revealed or sent). */
export function integrationsVault(backend: SecretBackend | undefined): IntegrationsVault | undefined {
  if (backend === undefined) return undefined;
  const vault = createVault({ backend, weakPolicy: "refuse" });
  const closed = (e: unknown): never => {
    throw new IntegrationRefusal(e instanceof VaultError ? reasonIn(VAULT_REASON, e.code) : "internal");
  };
  return Object.freeze({
    reveal: (entry: string) => vault.reveal(entry, "integration_request").catch(closed),
    info: async (entry: string) => {
      try {
        const i = await vault.info(entry);
        return i === undefined ? undefined : { protection: i.protection, backendChanged: i.backendChanged };
      } catch {
        throw new IntegrationRefusal("internal");
      }
    },
  });
}
