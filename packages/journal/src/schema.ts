// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Migration } from "@axis/audit";

/**
 * Journal schema, versioned in `axis_schema` under component `journal`.
 * Later migrations append to this list; they never edit an earlier entry.
 * `approvals` (docs/IMPLEMENTATION.md) arrives with the approval broker.
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
  {
    // The idempotency store's clock: accumulated process uptime in milliseconds, one row, advanced inside each write's
    // transaction. Rows are created, expire and are deleted by it; the wall clock is never used.
    version: 3,
    sql: `
      CREATE TABLE daemon_idempotency_clock (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        trusted_ms INTEGER NOT NULL CHECK (trusted_ms >= 0)
      ) STRICT;
    `,
  },
  {
    // Daemon host records (docs/design/daemon-host.md 7.5, ticket J1). The journal is authoritative for what a worktree is
    // (Q7); the worktree manager's own `WorkspaceMeta` file is checked against it. One transaction, so a failure part way
    // leaves version 3 untouched.
    //
    // SQLite cannot alter a CHECK, and `FINALISED` has to join the state list, so `agent_workspaces` is rebuilt. With
    // foreign keys on, a parent cannot be dropped while `agent_runs` points at it, so `agent_runs` is rebuilt first
    // (copied verbatim, same columns, same indexes) and renamed back after the parent. Neither `state_transitions`,
    // `idempotency`, the daemon idempotency tables nor any audit table is touched.
    //
    // Not recorded, on purpose (design Q7): the acknowledged GIT-SNAP baseline. It stays in the worktree's git directory
    // under the manager's own checks.
    version: 4,
    sql: `
      CREATE TABLE projects (
        id           TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
        -- canonical absolute path, chosen by the host, never taken from a request
        path         TEXT NOT NULL UNIQUE CHECK (length(path) BETWEEN 1 AND 4096),
        display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256),
        trusted      INTEGER NOT NULL CHECK (trusted IN (0, 1)),
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      ) STRICT;

      CREATE TABLE agent_workspaces_v4 (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        branch     TEXT NOT NULL,
        base_ref   TEXT NOT NULL,
        base_sha   TEXT NOT NULL,
        created_by TEXT NOT NULL,
        state      TEXT NOT NULL
                   CHECK (state IN ('CREATING','READY','FINALISED','REMOVING','REMOVED','FAILED')),
        reconcile_reported INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        -- canonical absolute path of the worktree, set once it exists
        worktree_path TEXT CHECK (worktree_path IS NULL OR length(worktree_path) BETWEEN 1 AND 4096),
        -- advisory record of the per-worktree lock; the lock itself is the host mutex. Recovery clears a stale one.
        lock_state TEXT NOT NULL DEFAULT 'unlocked' CHECK (lock_state IN ('unlocked','locked')),
        locked_at  TEXT,
        -- the last sha this workspace's branch was pushed at (the push base for @axis/git-ops), never a remote-tracking ref
        last_pushed_sha TEXT CHECK (last_pushed_sha IS NULL
          OR (length(last_pushed_sha) IN (40, 64) AND last_pushed_sha NOT GLOB '*[^0-9a-f]*')),
        -- the tree hash the person reviewed (REV-1)
        reviewed_tree_hash TEXT CHECK (reviewed_tree_hash IS NULL
          OR (length(reviewed_tree_hash) IN (40, 64) AND reviewed_tree_hash NOT GLOB '*[^0-9a-f]*')),
        reviewed_at TEXT,
        finalise_outcome TEXT CHECK (finalise_outcome IS NULL OR finalise_outcome IN ('merged','archived','abandoned')),
        CHECK ((lock_state = 'locked') = (locked_at IS NOT NULL)),
        CHECK ((reviewed_tree_hash IS NULL) = (reviewed_at IS NULL)),
        CHECK (state <> 'FINALISED' OR finalise_outcome IS NOT NULL),
        CHECK (finalise_outcome IS NULL OR state IN ('FINALISED','REMOVING','REMOVED'))
      ) STRICT;
      INSERT INTO agent_workspaces_v4 (id, project_id, branch, base_ref, base_sha, created_by, state, reconcile_reported, created_at, updated_at)
        SELECT id, project_id, branch, base_ref, base_sha, created_by, state, reconcile_reported, created_at, updated_at
        FROM agent_workspaces;

      CREATE TABLE agent_runs_v4 (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES agent_workspaces_v4(id),
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
      INSERT INTO agent_runs_v4 SELECT id, workspace_id, kind, state, reason, exit_code, created_at, updated_at, started_at, ended_at
        FROM agent_runs;

      DROP TABLE agent_runs;
      DROP TABLE agent_workspaces;
      ALTER TABLE agent_workspaces_v4 RENAME TO agent_workspaces;
      ALTER TABLE agent_runs_v4 RENAME TO agent_runs;
      CREATE INDEX agent_runs_by_workspace ON agent_runs (workspace_id);
      CREATE INDEX agent_runs_by_state ON agent_runs (state);
    `,
  },
];

export const JOURNAL_SCHEMA_VERSION = JOURNAL_MIGRATIONS.length;
