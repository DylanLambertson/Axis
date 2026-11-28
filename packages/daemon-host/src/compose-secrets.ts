// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { ControlClient } from "./control/client.js";
import type { Logger } from "./log/logger.js";
import { createBrokerSecretBackend, type BrokerSecretBackend } from "./secrets-backend.js";

/**
 * The secret broker wiring (PV-N0c-1, `docs/design/secret-broker.md` §3.5 and §6.1), behind ONE composition option that the
 * daemon entry does not set (a pinned test), so production is unchanged until PV-N0c-2 flips it with main's adapter:
 * - off (production): no broker backend is built, the composer serves the mock only, the integrations binding has no backend,
 *   and no `secrets.*` request is ever sent;
 * - on (tests until the flip): ONE backend over the control channel, handed to the providers binding (its vault with
 *   `weakPolicy: "refuse"`, so provider reveals are gated too, and the rollback timeout raised to 65 s) and to the integrations
 *   binding; then the startup reveal: every stored provider entry is revealed once with `validate_connection`, audited, and
 *   its key registered with the redactor. A failure leaves that one connection unvalidated, never the daemon: no retry at start
 *   (a later request reads its key again as every request does). Nothing about a key, not even its length, is logged or
 *   audited; the log carries closed reasons and counts only. Integration entries are not revealed at start.
 */

/** TEST ONLY until PV-N0c-2: turn the broker wiring on. `connectionId` is the provider connection the composer serves. */
export interface SecretBrokerOption {
  readonly connectionId: string;
}

/** The vault rollback of a timed-out `put` waits as long as main may (§3.4). */
export const BROKER_ROLLBACK_MS = 65_000;

/** What the composition hands on (it alone may load the bindings, so it makes the backend the vault's with `asVaultBackend`). */
export interface SecretBrokerWiring {
  /** The provider connection the composer serves over the broker. */
  readonly connectionId: string;
  /** The ONE backend, for the providers binding and the integrations binding alike. */
  readonly backend: BrokerSecretBackend;
  /** The providers binding's vault policy under the broker. */
  readonly vault: { readonly weakPolicy: "refuse"; readonly rollbackTimeoutMs: number };
  /** The startup reveal: `validate` is the providers binding's `validateStored`, stopped through `signal` at shutdown. Never throws. */
  startup(validate: (signal: AbortSignal) => Promise<{ readonly listed: boolean; readonly validated: number; readonly failed: number }>): Promise<void>;
  /**
   * Shutdown, before the audit writers are sealed: no further entry is read, and the read in flight gets up to STOP_WAIT_MS to
   * settle (and write its audit row). One still hung after that may complete at main with no row: an accepted residual.
   */
  stop(): Promise<void>;
}

/** How long shutdown waits for a startup read in flight. */
export const STOP_WAIT_MS = 1_000;

/** The wiring, or `undefined` when the option is off: the ONLY place a broker backend is built. */
export function secretBrokerWiring(option: SecretBrokerOption | undefined, control: ControlClient, logger: Logger | undefined): SecretBrokerWiring | undefined {
  if (option === undefined) return undefined;
  const backend = createBrokerSecretBackend({ client: control, onEvent: (e) => logger?.warn("secrets.broker", { reason: e.event.slice("secrets.".length) }) });
  const halt = new AbortController();
  let running: Promise<void> | undefined;
  return Object.freeze({
    connectionId: option.connectionId,
    backend,
    vault: Object.freeze({ weakPolicy: "refuse" as const, rollbackTimeoutMs: BROKER_ROLLBACK_MS }),
    startup(validate: (signal: AbortSignal) => Promise<{ readonly listed: boolean; readonly validated: number; readonly failed: number }>): Promise<void> {
      running ??= reveal(validate);
      return running;
    },
    async stop(): Promise<void> {
      halt.abort();
      if (running === undefined) return;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([running, new Promise((r) => (timer = setTimeout(r, STOP_WAIT_MS) as unknown as NodeJS.Timeout))]); // opaque handle under Code OSS's typings (ADR 0005)
      clearTimeout(timer);
    },
  });

  async function reveal(validate: (signal: AbortSignal) => Promise<{ readonly listed: boolean; readonly validated: number; readonly failed: number }>): Promise<void> {
    try {
      const r = await validate(halt.signal);
      if (!r.listed) logger?.warn("secrets.startup", { reason: "list_failed" });
      else logger?.info("secrets.startup", { reason: "validated", count: r.validated });
      if (r.failed > 0) logger?.warn("secrets.startup", { reason: "failed", count: r.failed });
    } catch {
      logger?.warn("secrets.startup", { reason: "internal" });
    }
  }
}
