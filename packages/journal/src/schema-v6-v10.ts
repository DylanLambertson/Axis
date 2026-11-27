// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Migration } from "@axis/audit";

/**
 * Journal schema versions 6 to 10, moved here unchanged from `schema.ts` (its migration list stays a list; `schema-layout.test.ts`).
 * Each entry's SQL is pinned by hash in `journal.test.ts`: never edit one, add a new migration instead.
 */
export const JOURNAL_V6_TO_V10: readonly Migration[] = [
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
  {
    // The commit the base branch pointed at when the workspace was created (ticket FU-WT-BASE2). `merged` is refused
    // unless the base branch still descends from it, so a base reset to an unrelated commit, rewritten history or a
    // deleted base cannot attest a merge. Recorded once, together with `base_branch` in one UPDATE (never added later to a
    // row whose base branch is already recorded, so a row from before this version stays not attestable); a tip needs a base branch and,
    // from this version on, a base branch needs a tip. NULL for every workspace made before this version. Additive.
    version: 7,
    sql: `
      ALTER TABLE agent_workspaces ADD COLUMN base_tip TEXT CHECK (base_tip IS NULL OR (
        length(base_tip) IN (40, 64) AND base_tip NOT GLOB '*[^0-9a-f]*'));
      CREATE TRIGGER agent_workspaces_base_tip_once BEFORE UPDATE OF base_tip ON agent_workspaces
        WHEN NEW.base_tip IS NOT OLD.base_tip
          AND (OLD.base_tip IS NOT NULL OR OLD.base_branch IS NOT NULL OR NEW.base_branch IS NULL)
        BEGIN SELECT RAISE(ABORT, 'base_tip is recorded once, with the base branch'); END;
      CREATE TRIGGER agent_workspaces_base_branch_with_tip BEFORE UPDATE OF base_branch ON agent_workspaces
        WHEN OLD.base_branch IS NULL AND NEW.base_branch IS NOT NULL AND NEW.base_tip IS NULL
        BEGIN SELECT RAISE(ABORT, 'base_branch is recorded with its tip'); END;
    `,
  },
  {
    // The taint rule IAC-T (ticket PV-M0, inter-agent-communication.md section 6.6): a composer run that received content
    // from anyone but the user is tainted for its whole life, also across a restart or a later resume of the run. The flag
    // only goes from 0 to 1; nothing clears it. 0 for every run made before this version (no source existed then). Additive.
    version: 8,
    sql: `
      ALTER TABLE composer_runs ADD COLUMN tainted INTEGER NOT NULL DEFAULT 0 CHECK (tainted IN (0, 1));
      CREATE TRIGGER composer_runs_taint_sticky BEFORE UPDATE OF tainted ON composer_runs
        WHEN NEW.tainted < OLD.tainted
        BEGIN SELECT RAISE(ABORT, 'a tainted run stays tainted'); END;
      -- INSERT OR REPLACE deletes the old row without firing a DELETE trigger, which would clear the taint: refused.
      CREATE TRIGGER composer_runs_inserted_once BEFORE INSERT ON composer_runs
        WHEN EXISTS (SELECT 1 FROM composer_runs WHERE run_id = NEW.run_id)
        BEGIN SELECT RAISE(ABORT, 'a composer run is recorded once'); END;
    `,
  },
  {
    // axis.messages/1 (ticket PV-M3, inter-agent-communication.md sections 2, 4.2 and 7): threads, their participant sets,
    // messages, who each message is addressed to, read cursors and messaging settings. Additive: new tables only.
    //
    // - A thread belongs to one registered project. Its `last_seq` only grows: a message must take the next one (trigger).
    // - Participants only join (no update, no delete, by trigger): `joined_seq` is the last message before the principal
    //   joined, so it reads messages after it and the ones addressed to it (section 4.2).
    // - A message is never changed. Its body is the sender's raw text (escaped on every way out, never here).
    // - `message_recipients` holds who a message is addressed to after group expansion; `counted` marks a message that
    //   counts against the recipient's queue quotas (an agent's or a plugin's, never the user's or the system's). A
    //   recipient row is never changed (it feeds the quotas).
    // - Messages and their recipient rows can be deleted: the retention purge (a later slice) removes them, recipient
    //   rows first. Threads, participants and cursors stay.
    // - A read cursor never moves back (trigger).
    version: 9,
    sql: `
      CREATE TABLE message_threads (
        id         TEXT PRIMARY KEY CHECK (length(id) = 26 AND substr(id, 1, 4) = 'thr_' AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
        project_id TEXT NOT NULL REFERENCES projects(id),
        created_at TEXT NOT NULL,
        last_seq   INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
        last_at    TEXT NOT NULL
      ) STRICT;
      CREATE INDEX message_threads_recent ON message_threads (last_at DESC, id);
      CREATE TRIGGER message_threads_fixed BEFORE UPDATE OF id, project_id, created_at ON message_threads
        BEGIN SELECT RAISE(ABORT, 'a thread keeps its id and project'); END;
      CREATE TRIGGER message_threads_forward BEFORE UPDATE OF last_seq ON message_threads
        WHEN NEW.last_seq < OLD.last_seq BEGIN SELECT RAISE(ABORT, 'a thread sequence only grows'); END;

      CREATE TABLE message_participants (
        thread_id  TEXT NOT NULL REFERENCES message_threads(id),
        principal  TEXT NOT NULL CHECK (length(principal) BETWEEN 4 AND 128 AND principal NOT GLOB '*[^A-Za-z0-9:._-]*'),
        joined_seq INTEGER NOT NULL CHECK (joined_seq >= 0),
        ord        INTEGER NOT NULL CHECK (ord BETWEEN 0 AND 63),
        PRIMARY KEY (thread_id, principal),
        UNIQUE (thread_id, ord)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX message_participants_by_principal ON message_participants (principal, thread_id);
      CREATE TRIGGER message_participants_kept BEFORE UPDATE ON message_participants
        BEGIN SELECT RAISE(ABORT, 'a participant only joins'); END;
      CREATE TRIGGER message_participants_no_delete BEFORE DELETE ON message_participants
        BEGIN SELECT RAISE(ABORT, 'a participant only joins'); END;

      CREATE TABLE agent_messages (
        id          TEXT PRIMARY KEY CHECK (length(id) = 26 AND substr(id, 1, 4) = 'msg_' AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
        thread_id   TEXT NOT NULL REFERENCES message_threads(id),
        seq         INTEGER NOT NULL CHECK (seq >= 1),
        sender      TEXT NOT NULL CHECK (length(sender) <= 1024 AND json_valid(sender)),
        sender_key  TEXT NOT NULL CHECK (length(sender_key) BETWEEN 4 AND 128),
        recipients  TEXT NOT NULL CHECK (length(recipients) <= 8192 AND json_valid(recipients)),
        expanded    TEXT NOT NULL CHECK (length(expanded) <= 8192 AND json_valid(expanded)),
        body        TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 16384),
        refs        TEXT NOT NULL CHECK (length(refs) <= 65536 AND json_valid(refs)),
        in_reply_to TEXT,
        hop         INTEGER NOT NULL CHECK (hop BETWEEN 0 AND 8),
        created_at  TEXT NOT NULL,
        UNIQUE (thread_id, seq)
      ) STRICT;
      CREATE TRIGGER agent_messages_in_order BEFORE INSERT ON agent_messages
        WHEN NEW.seq <> (SELECT last_seq + 1 FROM message_threads WHERE id = NEW.thread_id)
        BEGIN SELECT RAISE(ABORT, 'a message takes the next sequence of its thread'); END;
      CREATE TRIGGER agent_messages_added AFTER INSERT ON agent_messages BEGIN
        UPDATE message_threads SET last_seq = NEW.seq, last_at = NEW.created_at WHERE id = NEW.thread_id;
      END;
      CREATE TRIGGER agent_messages_immutable BEFORE UPDATE ON agent_messages
        BEGIN SELECT RAISE(ABORT, 'a message is never changed'); END;

      CREATE TABLE message_recipients (
        principal  TEXT NOT NULL CHECK (length(principal) BETWEEN 4 AND 128 AND principal NOT GLOB '*[^A-Za-z0-9:._-]*'),
        message_id TEXT NOT NULL REFERENCES agent_messages(id),
        thread_id  TEXT NOT NULL REFERENCES message_threads(id),
        seq        INTEGER NOT NULL CHECK (seq >= 1),
        sender_key TEXT NOT NULL,
        counted    INTEGER NOT NULL CHECK (counted IN (0, 1)),
        PRIMARY KEY (principal, message_id)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX message_recipients_by_thread ON message_recipients (principal, thread_id, seq);
      CREATE INDEX message_recipients_by_message ON message_recipients (message_id);
      CREATE TRIGGER message_recipients_fixed BEFORE UPDATE ON message_recipients
        BEGIN SELECT RAISE(ABORT, 'a recipient row is never changed'); END;

      CREATE TABLE message_cursors (
        thread_id    TEXT NOT NULL REFERENCES message_threads(id),
        principal    TEXT NOT NULL,
        read_through INTEGER NOT NULL CHECK (read_through >= 0),
        PRIMARY KEY (thread_id, principal)
      ) STRICT, WITHOUT ROWID;
      CREATE TRIGGER message_cursors_forward BEFORE UPDATE OF read_through ON message_cursors
        WHEN NEW.read_through < OLD.read_through BEGIN SELECT RAISE(ABORT, 'a read cursor never moves back'); END;

      CREATE TABLE messaging_settings (
        project_id TEXT PRIMARY KEY REFERENCES projects(id),
        body       TEXT NOT NULL CHECK (length(body) <= 65536 AND json_valid(body))
      ) STRICT;
      CREATE TABLE messaging_agent_settings (
        agent_id      TEXT PRIMARY KEY CHECK (length(agent_id) BETWEEN 1 AND 64),
        accepts_from  TEXT NOT NULL CHECK (accepts_from IN ('none','group','project')),
        cli_messaging INTEGER NOT NULL CHECK (cli_messaging IN (0, 1)),
        muted         INTEGER NOT NULL CHECK (muted IN (0, 1))
      ) STRICT;
    `,
  },
  {
    // Message delivery into runs (ticket PV-M3 slice 2, inter-agent-communication.md sections 3 and 6.1). One row per
    // message and recipient, so a message reaches a recipient at most once: `leased` when a live run took it at a turn
    // boundary (in the same transaction that taints the run), `acked` once the model's request that carried it succeeded,
    // or `failed` when its delivery failed `failures` times (quarantined: never offered again; the user is told). A lease
    // only moves to `acked`; an acked or failed row never changes. A lease is released (deleted) when the request that
    // carried it failed, when the run ended before it, and for every lease at host start (no run survives a restart), so
    // such a message goes to a later run. An acked or failed row is deleted only after its message (the retention purge),
    // so a delivered message cannot become deliverable again (the purge deletes both in one transaction with deferred
    // foreign keys). `message_delivery_failures` counts failed attempts. Additive.
    version: 10,
    sql: `
      CREATE TABLE message_deliveries (
        message_id TEXT NOT NULL REFERENCES agent_messages(id),
        principal  TEXT NOT NULL CHECK (length(principal) BETWEEN 4 AND 128 AND principal NOT GLOB '*[^A-Za-z0-9:._-]*'),
        run_id     TEXT NOT NULL REFERENCES agent_runs(id),
        state      TEXT NOT NULL CHECK (state IN ('leased','acked','failed')),
        leased_at  TEXT NOT NULL,
        acked_at   TEXT,
        PRIMARY KEY (message_id, principal),
        CHECK ((state = 'acked') = (acked_at IS NOT NULL))
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX message_deliveries_by_run ON message_deliveries (run_id, state);
      CREATE TRIGGER message_deliveries_forward BEFORE UPDATE ON message_deliveries
        WHEN OLD.state <> 'leased' OR NEW.state <> 'acked' OR NEW.message_id IS NOT OLD.message_id
          OR NEW.principal IS NOT OLD.principal OR NEW.run_id IS NOT OLD.run_id OR NEW.leased_at IS NOT OLD.leased_at
        BEGIN SELECT RAISE(ABORT, 'a delivery only moves from leased to acked'); END;
      CREATE TRIGGER message_deliveries_kept BEFORE DELETE ON message_deliveries
        WHEN OLD.state <> 'leased' AND EXISTS (SELECT 1 FROM agent_messages WHERE id = OLD.message_id)
        BEGIN SELECT RAISE(ABORT, 'a delivered message stays delivered'); END;
      CREATE TABLE message_delivery_failures (
        message_id TEXT NOT NULL REFERENCES agent_messages(id),
        principal  TEXT NOT NULL CHECK (length(principal) BETWEEN 4 AND 128 AND principal NOT GLOB '*[^A-Za-z0-9:._-]*'),
        failures   INTEGER NOT NULL CHECK (failures >= 1),
        PRIMARY KEY (message_id, principal)
      ) STRICT, WITHOUT ROWID;
    `,
  },
];
