// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Migration } from "@axis/audit";
import { SQL_RULES } from "./schema-pages.js";

/*
 * Plugin challenge issues (ticket PV-K1e-a2, OI-2 and OI-10 of ADR 0008, `docs/design/plugin-run-start.md`): schema version 17,
 * forward-only. One row per approval challenge a plugin caused, so "at most 6 per plugin and project in any hour" is counted in
 * SQL and survives a disable and enable (the rows do not depend on the plugin's switch) and a restart.
 *
 * - The newest row is the table's clock. An insert older than the newest row is refused, so the issue times only grow (the store
 *   clamps its time to the newest row: a system clock that steps back cannot open a fresh hour).
 * - A row never changes. The one delete is the prune of rows more than 24 hours older than the newest row: the window is one
 *   hour, so a prune can never remove a row that still counts. Every other delete is refused.
 * - At most 16,384 rows; an insert past that is refused (the store answers `issue_cap` first).
 * - Ids only: the plugin and project, no content. A row needs the plugin's `plugin_enablement` row (PV-K1b). The daemon is the
 *   only writer (the challenge gate); there is no actor column because no person writes it.
 */

const { id, pluginId } = SQL_RULES;

export const PLUGIN_ISSUE_LIMITS = Object.freeze({ perHour: 6, windowMs: 3_600_000, keepMs: 86_400_000, rows: 16_384 });
const MAX_MS = 8_640_000_000_000_000;

export const PLUGIN_ISSUES_MIGRATION: Migration = {
  version: 17,
  sql: `
    CREATE TABLE plugin_challenge_issues (
      seq        INTEGER PRIMARY KEY,
      plugin_id  TEXT NOT NULL CHECK (${pluginId("plugin_id")}),
      project_id TEXT NOT NULL CHECK (${id("project_id")}),
      issued_at  INTEGER NOT NULL CHECK (issued_at >= 0 AND issued_at <= ${MAX_MS}),
      FOREIGN KEY (plugin_id, project_id) REFERENCES plugin_enablement(plugin_id, project_id)
    ) STRICT;
    CREATE INDEX plugin_challenge_issues_by_plugin ON plugin_challenge_issues (plugin_id, project_id, issued_at);
    CREATE TRIGGER plugin_challenge_issues_inserted_once BEFORE INSERT ON plugin_challenge_issues
      WHEN NEW.seq IS NOT NULL AND EXISTS (SELECT 1 FROM plugin_challenge_issues WHERE seq = NEW.seq)
      BEGIN SELECT RAISE(ABORT, 'an issue row is inserted once'); END;
    CREATE TRIGGER plugin_challenge_issues_known BEFORE INSERT ON plugin_challenge_issues
      WHEN NOT EXISTS (SELECT 1 FROM plugin_enablement WHERE plugin_id = NEW.plugin_id AND project_id = NEW.project_id)
      BEGIN SELECT RAISE(ABORT, 'an issue needs the plugin added to the project'); END;
    CREATE TRIGGER plugin_challenge_issues_monotone BEFORE INSERT ON plugin_challenge_issues
      WHEN NEW.issued_at < (SELECT coalesce(max(issued_at), 0) FROM plugin_challenge_issues)
      BEGIN SELECT RAISE(ABORT, 'issue times only grow'); END;
    CREATE TRIGGER plugin_challenge_issues_cap BEFORE INSERT ON plugin_challenge_issues
      WHEN (SELECT count(*) FROM plugin_challenge_issues) >= ${PLUGIN_ISSUE_LIMITS.rows}
      BEGIN SELECT RAISE(ABORT, 'plugin_issue_cap'); END;
    CREATE TRIGGER plugin_challenge_issues_fixed BEFORE UPDATE ON plugin_challenge_issues
      BEGIN SELECT RAISE(ABORT, 'an issue row never changes'); END;
    CREATE TRIGGER plugin_challenge_issues_pruned BEFORE DELETE ON plugin_challenge_issues
      WHEN OLD.issued_at >= (SELECT max(issued_at) FROM plugin_challenge_issues) - ${PLUGIN_ISSUE_LIMITS.keepMs}
      BEGIN SELECT RAISE(ABORT, 'only rows more than 24 hours older than the newest are pruned'); END;
  `,
};
