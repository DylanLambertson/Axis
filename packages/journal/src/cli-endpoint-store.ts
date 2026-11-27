// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError, withTransaction, type AuditLog, type DatabaseSync } from "@axis/audit";

/**
 * The CLI messaging endpoint switch (schema version 20, PV-M7 slice 2; `docs/design/axis-messages-shim.md` section 7). Every
 * write is the user's own act: no method takes an actor, the row says `user`, and each change appends one
 * `journal.messaging.record` audit event with a fixed field and the new value, in the same transaction as the row. Which
 * caller may reach `set` (tier 4 natively confirmed to turn on, tier 1 to turn off) is the daemon's contract, not this store's.
 */

export const CLI_ENDPOINT_RECORD_ACTION = "journal.messaging.record";

export class CliEndpointSwitchRecords {
  readonly #db: DatabaseSync;
  readonly #audit: AuditLog;
  readonly #ts: () => string;

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

  /** Turn the switch on or off; `changed` is false when it already was, and then nothing is written or audited. */
  set(enabled: boolean): { readonly changed: boolean } {
    if (typeof enabled !== "boolean") throw new AxisError("E_INVALID_ARGUMENT", "The CLI endpoint switch was refused", { reason: "not_boolean" });
    return withTransaction(this.#db, () => {
      if (this.enabled() === enabled) return { changed: false };
      this.#db
        .prepare("INSERT INTO messaging_cli_endpoint (id, enabled, changed_by, changed_at) VALUES (1, ?, 'user', ?) ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, changed_at = excluded.changed_at")
        .run(enabled ? 1 : 0, this.#ts());
      this.#audit.append({ actor: "user", action: CLI_ENDPOINT_RECORD_ACTION, target: "messaging:cli_endpoint", outcome: "success", payload: { field: "cli_endpoint", enabled } });
      return { changed: true };
    });
  }
}
