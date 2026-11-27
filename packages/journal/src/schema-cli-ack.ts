// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Migration } from "@axis/audit";
import { SQL_RULES } from "./schema-pages.js";

/*
 * Acknowledged CLI project-configuration files (ticket PV-M7 slice 1, review 1 SF3 and SF4; `docs/design/messages-contract.md`
 * section 14): schema version 18, forward-only. When the user enables a CLI worker's messaging while CLI project-configuration files exist in its
 * home, the enable is a second step that names them; the paths acknowledged are kept here, and every mint compares the files
 * present then against them (a file that appeared since gets no endpoint until the user confirms again).
 *
 * - One row per worker and acknowledged path; ids and paths only, never a file's content. A path is a root-relative path of
 *   at most 64 characters of `[a-z0-9._/-]`: the daemon checks it against its list, the table only bounds its shape (so a
 *   new list entry needs no migration). At most 16 per worker.
 * - Insert once, never updated; the user is the only writer (`acknowledged_by`); turning messaging off, or acknowledging
 *   again, deletes the worker's rows in the same transaction as the setting.
 * - The worker must exist (a foreign key to `agents`). An archived worker keeps its rows, as its messaging settings do: an
 *   archived worker has no runs, so nothing is minted for it. A NUL in a path is refused (SQLite's `length` and `GLOB` stop
 *   at one).
 */

const { id, time } = SQL_RULES;

export const CLI_ACK_LIMITS = Object.freeze({ pathsPerWorker: 16 });

export const CLI_ACK_MIGRATION: Migration = {
  version: 18,
  sql: `
    CREATE TABLE messaging_cli_acknowledged (
      agent_id        TEXT NOT NULL REFERENCES agents(id) CHECK (${id("agent_id")}),
      path            TEXT NOT NULL CHECK (instr(path, char(0)) = 0 AND length(path) BETWEEN 1 AND 64 AND path NOT GLOB '*[^a-z0-9._/-]*'),
      acknowledged_by TEXT NOT NULL CHECK (acknowledged_by = 'user'),
      acknowledged_at TEXT NOT NULL CHECK (${time("acknowledged_at")}),
      PRIMARY KEY (agent_id, path)
    ) STRICT, WITHOUT ROWID;
    CREATE TRIGGER messaging_cli_acknowledged_once BEFORE INSERT ON messaging_cli_acknowledged
      WHEN EXISTS (SELECT 1 FROM messaging_cli_acknowledged WHERE agent_id = NEW.agent_id AND path = NEW.path)
      BEGIN SELECT RAISE(ABORT, 'a path is acknowledged once'); END;
    CREATE TRIGGER messaging_cli_acknowledged_per_worker BEFORE INSERT ON messaging_cli_acknowledged
      WHEN (SELECT count(*) FROM messaging_cli_acknowledged WHERE agent_id = NEW.agent_id) >= ${CLI_ACK_LIMITS.pathsPerWorker}
      BEGIN SELECT RAISE(ABORT, 'a worker holds at most ${CLI_ACK_LIMITS.pathsPerWorker} acknowledged paths'); END;
    CREATE TRIGGER messaging_cli_acknowledged_fixed BEFORE UPDATE ON messaging_cli_acknowledged
      BEGIN SELECT RAISE(ABORT, 'an acknowledgement never changes: delete it'); END;
  `,
};
