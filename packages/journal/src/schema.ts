// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Migration } from "@axis/audit";

/**
 * Journal schema, versioned in `axis_schema` under component `journal`.
 * Later migrations append to this list; they never edit an earlier entry.
 * `projects`, `worktrees` and `approvals` (docs/IMPLEMENTATION.md) arrive with
 * the worktree manager and the approval broker.
 */
export const JOURNAL_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE agent_workspaces (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        branch     TEXT NOT NULL,
        base_ref   TEXT NOT NULL,
        base_sha   TEXT NOT NULL,
        created_by TEXT NOT NULL,
        state      TEXT NOT NULL
                   CHECK (state IN ('CREATING','READY','REMOVING','REMOVED','FAILED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE agent_runs (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES agent_workspaces(id),
        kind         TEXT NOT NULL CHECK (kind IN ('composer','cli')),
        state        TEXT NOT NULL
                     CHECK (state IN ('QUEUED','RUNNING','REVIEWING','BLOCKED','COMPLETED','FAILED','CANCELLED')),
        reason       TEXT,
        exit_code    INTEGER,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        started_at   TEXT,
        ended_at     TEXT
      ) STRICT;
      CREATE INDEX agent_runs_by_workspace ON agent_runs (workspace_id);
      CREATE INDEX agent_runs_by_state ON agent_runs (state);

      CREATE TABLE state_transitions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity      TEXT NOT NULL CHECK (entity IN ('workspace','run')),
        entity_id   TEXT NOT NULL,
        from_state  TEXT,
        to_state    TEXT NOT NULL,
        reason      TEXT,
        actor       TEXT NOT NULL,
        ts          TEXT NOT NULL
      ) STRICT;
      CREATE INDEX state_transitions_by_entity ON state_transitions (entity, entity_id, id);

      CREATE TABLE idempotency (
        scope        TEXT NOT NULL,
        key          TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_id    TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      ) STRICT;
    `,
  },
];

export const JOURNAL_SCHEMA_VERSION = JOURNAL_MIGRATIONS.length;
