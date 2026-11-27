// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError, withTransaction, type AuditLog, type DatabaseSync } from "@axis/audit";

/**
 * The CLI messaging endpoint switch (schema version 20, PV-M7 slice 2; `docs/design/axis-messages-shim.md` section 7). Every
 * write is the user's own act: no method takes an actor, the row says `user`, and each change appends one
 * `journal.messaging.record` audit event with a fixed field and the new value, in the same transaction as the row.
 *
 * Turning it ON is an increase and needs a single-use token of this store (the K2-g3 pattern): the store hands its minting
 * function out once (`takeSwitchMint`), the host composition takes it at startup and passes it to the approved enable action
 * alone, and a writer rule keeps every other file away from `switchOn`, `takeSwitchMint` and the token. Turning it off is a
 * decrease and needs none; only the disable handler calls it. Which caller reaches either (tier 4 natively confirmed to turn on,
 * tier 1 to turn off) is the daemon's contract.
 */

export const CLI_ENDPOINT_RECORD_ACTION = "journal.messaging.record";

declare const SWITCH_WRITE: unique symbol;
/** A single-use permission to switch the CLI endpoint on through ONE `CliEndpointSwitchRecords` instance. */
export interface CliEndpointSwitchWrite {
  readonly [SWITCH_WRITE]: true;
}

const refused = (reason: string): AxisError => new AxisError("E_INVALID_ARGUMENT", "The CLI endpoint switch was refused", { reason });

export class CliEndpointSwitchRecords {
  readonly #db: DatabaseSync;
  readonly #audit: AuditLog;
  readonly #ts: () => string;
  /** The tokens this instance minted and has not yet spent: private, never exported, never enrolled from outside. */
  readonly #brand = new WeakSet<object>();
  #mintTaken = false;

  constructor(db: DatabaseSync, audit: AuditLog, ts: () => string) {
    this.#db = db;
    this.#audit = audit;
    this.#ts = ts;
  }

  /** Whether the user turned CLI messaging endpoints on. No row is off. */
  enabled(): boolean {
    const r = this.#db.prepare("SELECT enabled FROM messaging_cli_endpoint WHERE id = 1").get() as Record<string, unknown> | undefined;
    return r !== undefined && Number(r["enabled"]) === 1;
  }

  /**
   * This instance's minting function, ONCE: a second call throws, so if anything took it before the host composition, the host
   * fails to start. The function takes no argument: it makes a fresh frozen token and enrols it here.
   */
  takeSwitchMint(): () => CliEndpointSwitchWrite {
    if (this.#mintTaken) throw new AxisError("E_INTERNAL", "The CLI endpoint switch mint was already taken", { reason: "mint_taken" });
    this.#mintTaken = true;
    return () => {
      const token = Object.freeze(Object.create(null) as object);
      this.#brand.add(token);
      return token as CliEndpointSwitchWrite;
    };
  }

  /** Switch on with a token of this instance, spent first (a repeat that changes nothing spends it too). */
  switchOn(token: CliEndpointSwitchWrite): { readonly changed: boolean } {
    if (typeof token !== "object" || token === null || !this.#brand.has(token)) throw refused("token");
    this.#brand.delete(token);
    return this.#write(true);
  }

  /** Switch off; no token (a decrease). */
  switchOff(): { readonly changed: boolean } {
    return this.#write(false);
  }

  /** `changed` is false when the switch already was so, and then nothing is written or audited. */
  #write(enabled: boolean): { readonly changed: boolean } {
    return withTransaction(this.#db, () => {
      if (this.enabled() === enabled) return { changed: false };
      // The row is inserted once (the table's trigger refuses a second insert by any verb) and updated after.
      const present = this.#db.prepare("SELECT 1 FROM messaging_cli_endpoint WHERE id = 1").get() !== undefined;
      const sql = present
        ? "UPDATE messaging_cli_endpoint SET enabled = ?, changed_at = ? WHERE id = 1"
        : "INSERT INTO messaging_cli_endpoint (id, enabled, changed_by, changed_at) VALUES (1, ?, 'user', ?)";
      this.#db.prepare(sql).run(enabled ? 1 : 0, this.#ts());
      this.#audit.append({ actor: "user", action: CLI_ENDPOINT_RECORD_ACTION, target: "messaging:cli_endpoint", outcome: "success", payload: { field: "cli_endpoint", enabled } });
      return { changed: true };
    });
  }
}
