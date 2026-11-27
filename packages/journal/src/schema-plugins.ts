// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Migration } from "@axis/audit";
import { SQL_RULES } from "./schema-pages.js";

/*
 * Plugin grants (ticket PV-K1b, ADR 0008 decisions 4 and 6, `docs/design/plugin-grants.md`): schema version 16, forward-only.
 * A data layer the daemon's policy reads for every plugin call; nothing here installs, signs or runs a plugin (PV-K2).
 *
 * - `plugin_enablement`: one row per plugin and project, the plugin's switch there. It is never deleted (an uninstall is a
 *   disable and every grant revoked), so its `generation` never starts over: a challenge bound to a generation (OI-3) can never
 *   match again after a disable or a revoke. `generation` only grows, by exactly one, and only on a disable (enabled 1 -> 0) or a
 *   revoke (`revokes` + 1, which the delete of a grant does in the same statement). At most 64 plugins per project.
 * - `plugin_grants`: one row per plugin, project and permission, from the closed set of ADR 0008 decision 6 (`net:` and
 *   `integration:` wait for ADR 0009's install rule). A grant needs the plugin's row in the project; it may exist while the
 *   plugin is disabled (the policy then refuses: disabling keeps the grants, enabling again restores them without a new grant
 *   dialog). A grant never changes; revoking deletes it and bumps the generation.
 * - Every writer is the user: `set_by` and `granted_by` are always `user`, and the store's methods take no actor. The contract
 *   methods that will call them (PV-K2): `grant` and `enable` at tier 4 or main-owned, `revoke` and `disable` at tier 2 (a decrease
 *   applies at once; `docs/design/plugin-grant-contract.md`). K1b adds no contract or handler for them.
 * - Every table refuses an INSERT of a key that exists, before any conflict clause (INSERT OR REPLACE, REPLACE, OR IGNORE and
 *   an upsert all abort: the PV-G1 lesson); ids are the NUL-safe rules of `SQL_RULES`.
 */

const { id, pluginId, time } = SQL_RULES;

export const PLUGIN_PERMISSIONS = Object.freeze(["agents.read", "messages.send", "tasks.read", "tasks.write", "pages.read", "pages.write", "runs.start", "files.read"] as const);
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];
export const PLUGIN_LIMITS = Object.freeze({ pluginsPerProject: 64 });
const SET = PLUGIN_PERMISSIONS.map((p) => `'${p}'`).join(",");

export const PLUGIN_GRANTS_MIGRATION: Migration = {
  version: 16,
  sql: `
    CREATE TABLE plugin_enablement (
      plugin_id  TEXT NOT NULL CHECK (${pluginId("plugin_id")}),
      project_id TEXT NOT NULL REFERENCES projects(id) CHECK (${id("project_id")}),
      enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      generation INTEGER NOT NULL CHECK (generation >= 1),
      revokes    INTEGER NOT NULL CHECK (revokes >= 0),
      set_by     TEXT NOT NULL CHECK (set_by = 'user'),
      created_at TEXT NOT NULL CHECK (${time("created_at")}),
      updated_at TEXT NOT NULL CHECK (${time("updated_at")}),
      PRIMARY KEY (plugin_id, project_id)
    ) STRICT, WITHOUT ROWID;
    CREATE TRIGGER plugin_enablement_inserted_once BEFORE INSERT ON plugin_enablement
      WHEN EXISTS (SELECT 1 FROM plugin_enablement WHERE plugin_id = NEW.plugin_id AND project_id = NEW.project_id)
      BEGIN SELECT RAISE(ABORT, 'a plugin is added to a project once'); END;
    CREATE TRIGGER plugin_enablement_starts BEFORE INSERT ON plugin_enablement
      WHEN NEW.enabled <> 0 OR NEW.generation <> 1 OR NEW.revokes <> 0
      BEGIN SELECT RAISE(ABORT, 'a plugin starts disabled, at generation 1, with no revoke'); END;
    CREATE TRIGGER plugin_enablement_per_project BEFORE INSERT ON plugin_enablement
      WHEN (SELECT count(*) FROM plugin_enablement WHERE project_id = NEW.project_id) >= ${PLUGIN_LIMITS.pluginsPerProject}
      BEGIN SELECT RAISE(ABORT, 'a project holds at most ${PLUGIN_LIMITS.pluginsPerProject} plugins'); END;
    CREATE TRIGGER plugin_enablement_fixed BEFORE UPDATE OF plugin_id, project_id, created_at ON plugin_enablement
      WHEN NEW.plugin_id IS NOT OLD.plugin_id OR NEW.project_id IS NOT OLD.project_id OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'a plugin row keeps its plugin, project and creation time'); END;
    CREATE TRIGGER plugin_enablement_generation BEFORE UPDATE ON plugin_enablement
      WHEN NEW.revokes NOT IN (OLD.revokes, OLD.revokes + 1)
        OR NEW.generation IS NOT OLD.generation + ((OLD.enabled = 1 AND NEW.enabled = 0) OR NEW.revokes = OLD.revokes + 1)
      BEGIN SELECT RAISE(ABORT, 'a plugin''s generation grows by one on a disable or a revoke, and only then'); END;
    CREATE TRIGGER plugin_enablement_kept BEFORE DELETE ON plugin_enablement
      BEGIN SELECT RAISE(ABORT, 'a plugin row is never deleted: disable it and revoke its grants'); END;

    CREATE TABLE plugin_grants (
      plugin_id  TEXT NOT NULL,
      project_id TEXT NOT NULL,
      permission TEXT NOT NULL CHECK (permission IN (${SET})),
      granted_by TEXT NOT NULL CHECK (granted_by = 'user'),
      granted_at TEXT NOT NULL CHECK (${time("granted_at")}),
      PRIMARY KEY (plugin_id, project_id, permission),
      FOREIGN KEY (plugin_id, project_id) REFERENCES plugin_enablement(plugin_id, project_id)
    ) STRICT, WITHOUT ROWID;
    CREATE TRIGGER plugin_grants_inserted_once BEFORE INSERT ON plugin_grants
      WHEN EXISTS (SELECT 1 FROM plugin_grants WHERE plugin_id = NEW.plugin_id AND project_id = NEW.project_id AND permission = NEW.permission)
      BEGIN SELECT RAISE(ABORT, 'a permission is granted once'); END;
    CREATE TRIGGER plugin_grants_known BEFORE INSERT ON plugin_grants
      WHEN NOT EXISTS (SELECT 1 FROM plugin_enablement WHERE plugin_id = NEW.plugin_id AND project_id = NEW.project_id)
      BEGIN SELECT RAISE(ABORT, 'a grant needs the plugin added to the project'); END;
    CREATE TRIGGER plugin_grants_fixed BEFORE UPDATE ON plugin_grants
      BEGIN SELECT RAISE(ABORT, 'a grant never changes: revoke it'); END;
    CREATE TRIGGER plugin_grants_revoked AFTER DELETE ON plugin_grants
      BEGIN
        UPDATE plugin_enablement SET revokes = revokes + 1, generation = generation + 1
          WHERE plugin_id = OLD.plugin_id AND project_id = OLD.project_id;
      END;
  `,
};
