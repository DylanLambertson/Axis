// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError, withTransaction, type AuditLog, type DatabaseSync } from "@axis/audit";
import { PLUGIN_PERMISSIONS, type PluginPermission } from "./schema-plugins.js";

/**
 * Plugin grants (schema version 16, ticket PV-K1b). Every write is the user's own act: no method takes an actor, the rows say
 * `user`, and each write appends one `journal.plugin.record` audit event that names ids and a fixed field, never anything else.
 * The contract methods that will call these (PV-K2): `grant` and `enable` at tier 4 or main-owned, `revoke` and `disable` at tier 2
 * (a decrease applies at once; `docs/design/plugin-grant-contract.md`). Nothing in K1b calls them but tests.
 *
 * `state` is what the daemon's policy reads for every plugin call: whether the plugin is enabled in the project, its generation
 * (OI-3 binds challenges to it) and its granted permissions. A plugin that was never added is `undefined`.
 */

export const PLUGIN_RECORD_ACTION = "journal.plugin.record";

export interface PluginState {
  readonly enabled: boolean;
  readonly generation: number;
  readonly permissions: readonly PluginPermission[];
}

type Row = Record<string, unknown>;
const PERMS: ReadonlySet<string> = new Set(PLUGIN_PERMISSIONS);

const bad = (reason: string): AxisError => new AxisError("E_INVALID_ARGUMENT", "The plugin record was refused", { reason });

export class PluginGrantRecords {
  readonly #db: DatabaseSync;
  readonly #audit: AuditLog;
  readonly #ts: () => string;

  constructor(db: DatabaseSync, audit: AuditLog, ts: () => string) {
    this.#db = db;
    this.#audit = audit;
    this.#ts = ts;
  }

  #note(field: string, pluginId: string, projectId: string, extra: Record<string, string> = {}): void {
    this.#audit.append({ actor: "user", action: PLUGIN_RECORD_ACTION, target: `project:${projectId}`, outcome: "success", payload: { field, pluginId, projectId, ...extra } });
  }

  /** Enabled flag, generation and granted permissions of a plugin in a project, or undefined when it was never added there. */
  state(pluginId: string, projectId: string): PluginState | undefined {
    const r = this.#db.prepare("SELECT enabled, generation FROM plugin_enablement WHERE plugin_id = ? AND project_id = ?").get(pluginId, projectId) as Row | undefined;
    if (r === undefined) return undefined;
    const perms = (this.#db.prepare("SELECT permission FROM plugin_grants WHERE plugin_id = ? AND project_id = ? ORDER BY permission").all(pluginId, projectId) as Row[])
      .map((x) => String(x["permission"]))
      .filter((p): p is PluginPermission => PERMS.has(p));
    return { enabled: Number(r["enabled"]) === 1, generation: Number(r["generation"]), permissions: perms };
  }

  /** The user added the plugin to the project: disabled, generation 1, no grant. Added once. */
  add(pluginId: string, projectId: string): void {
    const at = this.#ts();
    withTransaction(this.#db, () => {
      this.#db.prepare("INSERT INTO plugin_enablement (plugin_id, project_id, enabled, generation, revokes, set_by, created_at, updated_at) VALUES (?, ?, 0, 1, 0, 'user', ?, ?)").run(pluginId, projectId, at, at);
      this.#note("added", pluginId, projectId);
    });
  }

  /** Turn the plugin on or off in the project; off bumps its generation (the table's trigger checks the step). */
  setEnabled(pluginId: string, projectId: string, enabled: boolean): void {
    if (typeof enabled !== "boolean") throw bad("enabled");
    withTransaction(this.#db, () => {
      const r = this.#db.prepare("SELECT enabled FROM plugin_enablement WHERE plugin_id = ? AND project_id = ?").get(pluginId, projectId) as Row | undefined;
      if (r === undefined) throw bad("unknown");
      const was = Number(r["enabled"]) === 1;
      if (was === enabled) return;
      this.#db
        .prepare("UPDATE plugin_enablement SET enabled = ?, generation = generation + ?, updated_at = ? WHERE plugin_id = ? AND project_id = ?")
        .run(enabled ? 1 : 0, enabled ? 0 : 1, this.#ts(), pluginId, projectId);
      this.#note(enabled ? "enabled" : "disabled", pluginId, projectId);
    });
  }

  /** Grant one permission of the closed set. A grant needs the plugin added; granting twice is refused by the table. */
  grant(pluginId: string, projectId: string, permission: PluginPermission): void {
    if (!PERMS.has(permission)) throw bad("permission");
    withTransaction(this.#db, () => {
      this.#db.prepare("INSERT INTO plugin_grants (plugin_id, project_id, permission, granted_by, granted_at) VALUES (?, ?, ?, 'user', ?)").run(pluginId, projectId, permission, this.#ts());
      this.#note("granted", pluginId, projectId, { permission });
    });
  }

  /** Revoke one permission; the table bumps the generation in the same statement. False when it was not granted. */
  revoke(pluginId: string, projectId: string, permission: PluginPermission): boolean {
    if (!PERMS.has(permission)) throw bad("permission");
    return withTransaction(this.#db, () => {
      const n = Number(this.#db.prepare("DELETE FROM plugin_grants WHERE plugin_id = ? AND project_id = ? AND permission = ?").run(pluginId, projectId, permission).changes);
      if (n === 0) return false;
      this.#db.prepare("UPDATE plugin_enablement SET updated_at = ? WHERE plugin_id = ? AND project_id = ?").run(this.#ts(), pluginId, projectId);
      this.#note("revoked", pluginId, projectId, { permission });
      return true;
    });
  }
}
