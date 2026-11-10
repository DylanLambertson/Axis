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
        -- absolute, no NUL, no trailing separator, not a root: two spellings of one directory cannot both register
        path         TEXT NOT NULL UNIQUE CHECK (length(path) BETWEEN 2 AND 4096 AND instr(path, char(0)) = 0
                       AND substr(path, -1) NOT IN ('/', '\\') AND (substr(path, 1, 1) IN ('/', '\\') OR substr(path, 2, 1) = ':')),
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
        worktree_path TEXT CHECK (worktree_path IS NULL OR (length(worktree_path) BETWEEN 2 AND 4096 AND instr(worktree_path, char(0)) = 0
          AND substr(worktree_path, -1) NOT IN ('/', '\\') AND (substr(worktree_path, 1, 1) IN ('/', '\\') OR substr(worktree_path, 2, 1) = ':'))),
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
        -- a workspace that is gone holds no lock
        CHECK (lock_state = 'unlocked' OR state NOT IN ('REMOVED','FAILED')),
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
      -- one live workspace per worktree path; a path can be reused once its workspace is removed or failed
      CREATE UNIQUE INDEX agent_workspaces_live_worktree_path ON agent_workspaces (worktree_path)
        WHERE worktree_path IS NOT NULL AND state NOT IN ('REMOVED','FAILED');
    `,
  },
  {
    // The base branch the daemon resolved when the workspace was created (ticket FU-WT-BASE). `merged` is judged against
    // this record, never against the shared `HEAD` or the worktree manager's own metadata file, both of which a finished
    // run can write. A full `refs/heads/...` name of printable ASCII, or NULL when the base was not a local branch, when
    // the name could not be recorded, or for every workspace made before this version: NULL means "not attestable", and
    // a finalise to `merged` refuses. Set once, while the workspace is CREATING (the trigger refuses any later change, so
    // no code path can move it). Additive: no table is rebuilt and no row changes.
    version: 5,
    sql: `
      ALTER TABLE agent_workspaces ADD COLUMN base_branch TEXT CHECK (base_branch IS NULL OR (
        substr(base_branch, 1, 11) = 'refs/heads/' AND length(base_branch) BETWEEN 12 AND 300
        AND base_branch NOT GLOB '*[^!-~]*' AND instr(base_branch, '..') = 0));
      CREATE TRIGGER agent_workspaces_base_branch_once BEFORE UPDATE OF base_branch ON agent_workspaces
        WHEN OLD.base_branch IS NOT NULL AND NEW.base_branch IS NOT OLD.base_branch
        BEGIN SELECT RAISE(ABORT, 'base_branch is recorded once'); END;
    `,
  },
  {
    // Composer runs across a restart (docs/design/composer-runtime.md, tickets J2 and C10). Additive: three new tables,
    // one counter row and their triggers; no existing table or row changes.
    //
    // - `composer_runs`: what a composer run was started with (mode, provider, model: recorded once, never changed),
    //   its last reported usage, its budget totals (settled plus reserved, so a request in flight when the process dies
    //   stays charged), and counters of its stored activity kept by the triggers below.
    // - `composer_activity`: the run's display-safe events (the host redacts and validates them first), append-only,
    //   bounded by row and byte caps the store enforces (oldest first). `seq` only grows within a run.
    // - `composer_workspace_budgets`: the per-workspace budget totals (PRV-6, C10). A row is never deleted and its
    //   request count never goes down, so no restart or code path can hand a workspace a fresh budget.
    version: 6,
    sql: `
      CREATE TABLE composer_runs (
        run_id         TEXT PRIMARY KEY REFERENCES agent_runs(id),
        mode           TEXT NOT NULL CHECK (mode IN ('ask','edit','agent')),
        provider_id    TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 64 AND provider_id NOT GLOB '*[^a-z0-9-]*'),
        model_id       TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 256 AND model_id NOT GLOB '*[^!-~]*'),
        input_tokens   INTEGER CHECK (input_tokens >= 0),
        output_tokens  INTEGER CHECK (output_tokens >= 0),
        usage_requests INTEGER CHECK (usage_requests >= 0),
        budget_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (budget_tokens >= 0),
        budget_cost_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK (budget_cost_micro_usd >= 0),
        budget_requests INTEGER NOT NULL DEFAULT 0 CHECK (budget_requests >= 0),
        budget_unpriced INTEGER NOT NULL DEFAULT 0 CHECK (budget_unpriced >= 0),
        last_seq       INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
        activity_rows  INTEGER NOT NULL DEFAULT 0 CHECK (activity_rows >= 0),
        activity_bytes INTEGER NOT NULL DEFAULT 0 CHECK (activity_bytes >= 0),
        created_at     TEXT NOT NULL,
        CHECK ((input_tokens IS NULL) = (output_tokens IS NULL) AND (input_tokens IS NULL) = (usage_requests IS NULL))
      ) STRICT;
      CREATE TRIGGER composer_runs_started_once BEFORE UPDATE OF run_id, mode, provider_id, model_id, created_at ON composer_runs
        WHEN NEW.run_id IS NOT OLD.run_id OR NEW.mode IS NOT OLD.mode OR NEW.provider_id IS NOT OLD.provider_id
          OR NEW.model_id IS NOT OLD.model_id OR NEW.created_at IS NOT OLD.created_at
        BEGIN SELECT RAISE(ABORT, 'a composer run is recorded once'); END;
      CREATE TRIGGER composer_runs_kept BEFORE DELETE ON composer_runs
        BEGIN SELECT RAISE(ABORT, 'a composer run record is never deleted'); END;
      CREATE TRIGGER composer_runs_budget_forward BEFORE UPDATE OF budget_requests, budget_unpriced ON composer_runs
        WHEN NEW.budget_requests < OLD.budget_requests OR NEW.budget_unpriced < OLD.budget_unpriced
        BEGIN SELECT RAISE(ABORT, 'a run budget only moves forward'); END;

      CREATE TABLE composer_activity (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id  TEXT NOT NULL REFERENCES composer_runs(run_id),
        seq     INTEGER NOT NULL CHECK (seq >= 1),
        type    TEXT NOT NULL CHECK (type IN ('state','text','tool','approval','usage','request')),
        at      TEXT NOT NULL CHECK (length(at) BETWEEN 1 AND 64),
        body    TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 65536 AND json_valid(body) AND json_extract(body, '$.type') = type),
        UNIQUE (run_id, seq)
      ) STRICT;
      CREATE TABLE composer_activity_totals (
        id    INTEGER PRIMARY KEY CHECK (id = 1),
        rows  INTEGER NOT NULL CHECK (rows >= 0),
        bytes INTEGER NOT NULL CHECK (bytes >= 0)
      ) STRICT;
      INSERT INTO composer_activity_totals (id, rows, bytes) VALUES (1, 0, 0);
      CREATE TRIGGER composer_activity_in_order BEFORE INSERT ON composer_activity
        WHEN NEW.seq <= (SELECT last_seq FROM composer_runs WHERE run_id = NEW.run_id)
        BEGIN SELECT RAISE(ABORT, 'activity is appended in sequence order'); END;
      CREATE TRIGGER composer_activity_append_only BEFORE UPDATE ON composer_activity
        BEGIN SELECT RAISE(ABORT, 'activity rows are never changed'); END;
      CREATE TRIGGER composer_activity_added AFTER INSERT ON composer_activity BEGIN
        UPDATE composer_runs SET last_seq = NEW.seq, activity_rows = activity_rows + 1,
          activity_bytes = activity_bytes + length(CAST(NEW.body AS BLOB)) WHERE run_id = NEW.run_id;
        UPDATE composer_activity_totals SET rows = rows + 1, bytes = bytes + length(CAST(NEW.body AS BLOB)) WHERE id = 1;
      END;
      CREATE TRIGGER composer_activity_evicted AFTER DELETE ON composer_activity BEGIN
        UPDATE composer_runs SET activity_rows = activity_rows - 1,
          activity_bytes = activity_bytes - length(CAST(OLD.body AS BLOB)) WHERE run_id = OLD.run_id;
        UPDATE composer_activity_totals SET rows = rows - 1, bytes = bytes - length(CAST(OLD.body AS BLOB)) WHERE id = 1;
      END;

      CREATE TABLE composer_workspace_budgets (
        workspace_id   TEXT PRIMARY KEY REFERENCES agent_workspaces(id),
        tokens         INTEGER NOT NULL CHECK (tokens >= 0),
        cost_micro_usd INTEGER NOT NULL CHECK (cost_micro_usd >= 0),
        requests       INTEGER NOT NULL CHECK (requests >= 0),
        unpriced       INTEGER NOT NULL CHECK (unpriced >= 0),
        updated_at     TEXT NOT NULL
      ) STRICT;
      CREATE TRIGGER composer_workspace_budgets_kept BEFORE DELETE ON composer_workspace_budgets
        BEGIN SELECT RAISE(ABORT, 'a workspace budget is never deleted'); END;
      CREATE TRIGGER composer_workspace_budgets_forward BEFORE UPDATE ON composer_workspace_budgets
        WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.requests < OLD.requests OR NEW.unpriced < OLD.unpriced
        BEGIN SELECT RAISE(ABORT, 'a workspace budget only moves forward'); END;
    `,
  },
];

export const JOURNAL_SCHEMA_VERSION = JOURNAL_MIGRATIONS.length;
