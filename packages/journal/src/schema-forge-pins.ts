// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Migration } from "@axis/audit";

/*
 * The user's confirmed forge repository per project (ticket PV-D2 slice 2b, docs/design/forge-pr-list.md §2 and §9): schema
 * version 13, forward-only.
 *
 * - One row per project: the github.com owner and repository the user confirmed (`axis.forge/1.pinRepository`, tier 1, user
 *   only), as confirmed, and when. The checks repeat `vetOwnerRepo` of `@axis/protocol` (the GitHub owner pattern, the
 *   repository pattern, never `.` or `..`); the daemon also re-vets every value it reads and treats anything else as no pin.
 * - `confirmed_by` is always `user`, as `created_by` of version 12: the write is the user's own act; the daemon's policy row and
 *   handler admit only the user's desktop connection.
 * - A pin is inserted once and re-pinned in place (`UPDATE`); its project never changes. The insert guard fires before any
 *   conflict clause, so `INSERT OR REPLACE` (which would delete the old row without firing an UPDATE trigger), `INSERT OR
 *   IGNORE` and an upsert on an existing project all abort (the PV-G1 lesson, `agents_inserted_once`).
 * - A pin is kept when the project's `origin` changes: the daemon then answers `remote_changed`, showing the pin next to the
 *   new value, and the user re-pins. No writer deletes a pin; one that is gone is no pin, which fails closed (the project is
 *   unconfirmed again and no `gh` runs). There is no project removal today: the change that adds one deletes the pin with it.
 */

export const FORGE_PINS_MIGRATION: Migration = {
  version: 13,
  sql: `
    CREATE TABLE forge_pins (
      project_id   TEXT PRIMARY KEY REFERENCES projects(id),
      host         TEXT NOT NULL CHECK (host = 'github.com'),
      owner        TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 39 AND substr(owner, 1, 1) GLOB '[A-Za-z0-9]'
                     AND owner NOT GLOB '*[^A-Za-z0-9-]*'),
      repo         TEXT NOT NULL CHECK (length(repo) BETWEEN 1 AND 100 AND repo NOT GLOB '*[^A-Za-z0-9._-]*'
                     AND repo NOT IN ('.', '..')),
      confirmed_by TEXT NOT NULL CHECK (confirmed_by = 'user'),
      confirmed_at TEXT NOT NULL CHECK (length(confirmed_at) BETWEEN 20 AND 30)
    ) STRICT, WITHOUT ROWID;
    CREATE TRIGGER forge_pins_inserted_once BEFORE INSERT ON forge_pins
      WHEN EXISTS (SELECT 1 FROM forge_pins WHERE project_id = NEW.project_id)
      BEGIN SELECT RAISE(ABORT, 'a pin is inserted once; a re-pin updates it'); END;
    CREATE TRIGGER forge_pins_project_fixed BEFORE UPDATE OF project_id ON forge_pins
      WHEN NEW.project_id IS NOT OLD.project_id
      BEGIN SELECT RAISE(ABORT, 'a pin keeps its project'); END;
  `,
};
