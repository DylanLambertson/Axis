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
        -- 1 once recovery has reported this REMOVING workspace; cleared on any state change
        reconcile_reported INTEGER NOT NULL DEFAULT 0,
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
  {
    // The daemon's idempotency store (ADR 0005 D9: same database, same transactions). The older `idempotency`
    // table above only dedupes journal creates; this one holds request outcomes for the RPC pipeline.
    version: 2,
    sql: `
      CREATE TABLE daemon_idempotency (
        actor_id       TEXT NOT NULL,
        workspace_id   TEXT NOT NULL,
        contract       TEXT NOT NULL,
        version        INTEGER NOT NULL,
        method         TEXT NOT NULL,
        key            TEXT NOT NULL,
        request_hash   TEXT NOT NULL CHECK (length(request_hash) <= 128),
        state          TEXT NOT NULL CHECK (state IN ('in-progress','completed','unknown')),
        -- the store instance that began the call; an in-progress row from another boot is a dead process's
        boot_id        TEXT NOT NULL,
        unknown_reason TEXT CHECK (unknown_reason IN ('interrupted','result-not-stored','failed-after-start')),
        result         TEXT CHECK (result IS NULL OR length(result) <= 1048576),
        result_bytes   INTEGER NOT NULL DEFAULT 0,
        origin         TEXT NOT NULL DEFAULT '' CHECK (length(origin) <= 256),
        created_at     INTEGER NOT NULL,
        expires_at     INTEGER NOT NULL,
        PRIMARY KEY (actor_id, workspace_id, contract, version, method, key),
        CHECK ((state = 'completed') = (result IS NOT NULL)),
        CHECK ((state = 'unknown') = (unknown_reason IS NOT NULL))
      ) STRICT;
      CREATE INDEX daemon_idempotency_expiry ON daemon_idempotency (expires_at);
      CREATE INDEX daemon_idempotency_budget ON daemon_idempotency (actor_id, workspace_id, created_at);
    `,
  },
];

export const JOURNAL_SCHEMA_VERSION = JOURNAL_MIGRATIONS.length;
