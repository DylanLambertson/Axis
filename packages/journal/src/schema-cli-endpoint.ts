// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Migration } from "@axis/audit";
import { SQL_RULES } from "./schema-pages.js";

/*
 * The CLI messaging endpoint switch (ticket PV-M7 slice 2; `docs/design/axis-messages-shim.md` section 7): schema version
 * 20, forward-only. Production keeps CLI messaging off until the user turns this on through a natively confirmed tier 4
 * action; a tier 1 action turns it off. The daemon reads it at start and on every change, and the mint reads it again.
 *
 * - One row at most (`id` is 1). No row means off, so an existing database needs nothing written to stay off.
 * - The user is the only writer (`changed_by`), on insert and on every update; the store appends one audit event in the
 *   same transaction as each change.
 * - Never deleted: turning off writes 0, so the last change and its time stay readable.
 */

const { time } = SQL_RULES;

export const CLI_ENDPOINT_SWITCH_MIGRATION: Migration = {
  version: 20,
  sql: `
    CREATE TABLE messaging_cli_endpoint (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      changed_by TEXT NOT NULL CHECK (changed_by = 'user'),
      changed_at TEXT NOT NULL CHECK (${time("changed_at")})
    ) STRICT;
    CREATE TRIGGER messaging_cli_endpoint_kept BEFORE DELETE ON messaging_cli_endpoint
      BEGIN SELECT RAISE(ABORT, 'the CLI endpoint switch is turned off, never deleted'); END;
  `,
};
