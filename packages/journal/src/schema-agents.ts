// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Migration } from "@axis/audit";

/*
 * Agents and agent groups (ticket PV-G1, ADR 0006 decisions 4 to 6 and 10): schema version 12, forward-only.
 *
 * - `agent_groups`: one level, ordered (`ord`, ties by id), inside one project. Deleting a group ungroups its agents in
 *   the same statement (trigger); it never archives them.
 * - `agents`: a named, typed agent inside one project with exactly one home workspace and at most one group.
 *   - Its id, project, kind, home workspace and creation time are fixed at insert (its creator is always `user`).
 *   - Its launch is a reference, never a command, a path or a credential: a CLI agent names an `axis.cliAgents` entry id;
 *     a composer agent names a vault connection, a model id and a default mode.
 *   - The agent, its home workspace and its group belong to one project: both are composite foreign keys over
 *     `(project_id, id)`, so no write can cross projects.
 *   - An agent is never deleted: it is archived. Archiving never touches its workspace. A live agent's name is unique in
 *     its project, ignoring ASCII case ("Planner" and "planner" cannot both be live; other Unicode case pairs and
 *     look-alikes are not folded, and agents are addressed by id, never by name). Restoring needs a live home.
 *   - A home is live while its workspace is CREATING or READY. A workspace that leaves that set for FINALISED, REMOVING,
 *     REMOVED or FAILED archives every live agent it is home to, in the same statement, so no live agent ever points at a
 *     finished or removed workspace whatever code path moved it (ADR 0006 decision 5: an agent runs only while its home is
 *     READY). The daemon writes the audit events for that archive (PV-G3); the schema only keeps the invariant.
 *   - Every table here, and `agent_runs` and `agent_workspaces`, refuses an INSERT of an id that exists: `INSERT OR
 *     REPLACE` deletes the old row without firing a DELETE or UPDATE trigger, which would bypass every fixed-column,
 *     never-deleted and archive rule above (the guard `composer_runs_inserted_once` of version 8 closes the same hole).
 *     The guard fires before any conflict clause, so `INSERT OR IGNORE` and `ON CONFLICT ... DO NOTHING / DO UPDATE` on
 *     an existing id abort as well; an upsert on these tables needs the guard dropped on purpose. The error is the
 *     trigger's (SQLITE_CONSTRAINT_TRIGGER, errcode 1811), not a UNIQUE or PRIMARY KEY one (2067, 1555): `isUnique` in
 *     `records.ts` does not see a duplicate id here, so a store (PV-G3) that maps duplicates must check the id first or
 *     match the trigger's message.
 *   - `created_by` is always `user`: agent and group writes are user-only (ADR 0006 decision 10). Group membership
 *     feeds the messaging send policy (`accepts_from: group`), which is why it is constrained here as well.
 * - `agent_runs.agent_id`: NULL for every run recorded before this version and for runs started without an agent. It is
 *   fixed at insert. A run with an agent runs in that agent's home workspace, has the agent's kind, and is never started
 *   for an archived agent. "From 1c runs start only from an agent" is the daemon's rule (PV-G4), not this schema's:
 *   today's run paths insert runs with no agent.
 *
 * Ids follow the protocol's journal id (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, `messages-wire.ts`), so a messaging
 * principal `agent:<id>` stays within its 128 characters. Names are 1 to 64 characters with no leading or trailing
 * space and no character of `NAME_REFUSED_RANGES`.
 */

type Range = number | readonly [number, number];
/**
 * The code points an agent or group name refuses, defined once here. It is the protocol's `safeTextSchema` set (Cc, the
 * line and paragraph separators, and Cf, as `@axis/protocol` `CC_CS_LS_RANGES` and `CF_RANGES` pin them at Unicode
 * 17.0; surrogates cannot be stored as text) plus the invisible and no-break spaces U+00A0, U+2000 to U+200A, U+202F and
 * U+205F. NUL is refused separately (it cannot appear in a GLOB pattern). PV-G2's name schema in `@axis/protocol`
 * (which cannot import this package) must refuse exactly this set plus NUL; a daemon-host test, which sees both packages,
 * compares the two over every code point.
 */
export const NAME_REFUSED_RANGES: readonly Range[] = [
  [0x1, 0x1f], [0x7f, 0x9f], 0xa0, 0xad, [0x600, 0x605], 0x61c, 0x6dd, 0x70f, [0x890, 0x891], 0x8e2, 0x180e,
  [0x2000, 0x200f], [0x2028, 0x202f], [0x205f, 0x2064], [0x2066, 0x206f], 0xfeff, [0xfff9, 0xfffb], 0x110bd, 0x110cd,
  [0x13430, 0x1343f], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a], 0xe0001, [0xe0020, 0xe007f],
];

const id = (col: string): string =>
  `length(${col}) <= 64 AND substr(${col}, 1, 1) GLOB '[A-Za-z0-9]' AND ${col} NOT GLOB '*[^A-Za-z0-9_-]*'`;
const BAD_NAME_CHARS = `'*[' || ${NAME_REFUSED_RANGES.map((r) => (typeof r === "number" ? `char(${r})` : `char(${r[0]}) || '-' || char(${r[1]})`)).join(" || ")} || ']*'`;
const name = (col: string): string =>
  `length(${col}) BETWEEN 1 AND 64 AND ${col} = trim(${col}) AND instr(${col}, char(0)) = 0 AND ${col} NOT GLOB (${BAD_NAME_CHARS})`;
const LIVE = `('CREATING','READY')`;

export const AGENTS_MIGRATION: Migration = {
  version: 12,
  sql: `
    CREATE UNIQUE INDEX agent_workspaces_by_project ON agent_workspaces (project_id, id);

    CREATE TABLE agent_groups (
      id         TEXT PRIMARY KEY CHECK (${id("id")}),
      project_id TEXT NOT NULL REFERENCES projects(id),
      name       TEXT NOT NULL CHECK (${name("name")}),
      ord        INTEGER NOT NULL CHECK (ord BETWEEN 0 AND 9999),
      created_by TEXT NOT NULL CHECK (created_by = 'user'),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, id)
    ) STRICT;
    CREATE INDEX agent_groups_in_order ON agent_groups (project_id, ord, id);
    CREATE TRIGGER agent_groups_fixed BEFORE UPDATE OF id, project_id, created_at ON agent_groups
      WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'a group keeps its id, project and creation time'); END;
    CREATE TRIGGER agent_groups_inserted_once BEFORE INSERT ON agent_groups
      WHEN EXISTS (SELECT 1 FROM agent_groups WHERE id = NEW.id)
      BEGIN SELECT RAISE(ABORT, 'a group is inserted once'); END;
    CREATE TRIGGER agent_groups_ungroup BEFORE DELETE ON agent_groups
      BEGIN UPDATE agents SET group_id = NULL WHERE group_id = OLD.id; END;

    CREATE TABLE agents (
      id                TEXT PRIMARY KEY CHECK (${id("id")}),
      project_id        TEXT NOT NULL REFERENCES projects(id),
      name              TEXT NOT NULL CHECK (${name("name")}),
      kind              TEXT NOT NULL CHECK (kind IN ('composer','cli')),
      cli_entry_id      TEXT CHECK (cli_entry_id IS NULL OR (length(cli_entry_id) BETWEEN 1 AND 64
                          AND substr(cli_entry_id, 1, 1) GLOB '[a-z0-9]' AND cli_entry_id NOT GLOB '*[^a-z0-9._-]*')),
      connection        TEXT CHECK (connection IS NULL OR (length(connection) BETWEEN 1 AND 64
                          AND substr(connection, 1, 1) GLOB '[a-z0-9]' AND connection NOT GLOB '*[^a-z0-9._-]*')),
      model_id          TEXT CHECK (model_id IS NULL OR (length(model_id) BETWEEN 1 AND 256 AND model_id NOT GLOB '*[^!-~]*')),
      default_mode      TEXT CHECK (default_mode IS NULL OR default_mode IN ('ask','edit','agent')),
      home_workspace_id TEXT NOT NULL,
      group_id          TEXT,
      archived          INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      archived_at       TEXT,
      created_by        TEXT NOT NULL CHECK (created_by = 'user'),
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      CHECK (kind <> 'cli' OR (cli_entry_id IS NOT NULL AND connection IS NULL AND model_id IS NULL AND default_mode IS NULL)),
      CHECK (kind <> 'composer' OR (cli_entry_id IS NULL AND connection IS NOT NULL AND model_id IS NOT NULL AND default_mode IS NOT NULL)),
      CHECK ((archived = 1) = (archived_at IS NOT NULL)),
      FOREIGN KEY (project_id, home_workspace_id) REFERENCES agent_workspaces (project_id, id),
      FOREIGN KEY (project_id, group_id) REFERENCES agent_groups (project_id, id)
    ) STRICT;
    CREATE UNIQUE INDEX agents_live_name ON agents (project_id, name COLLATE NOCASE) WHERE archived = 0;
    CREATE INDEX agents_by_home ON agents (home_workspace_id);
    CREATE INDEX agents_by_group ON agents (group_id) WHERE group_id IS NOT NULL;
    CREATE TRIGGER agents_fixed BEFORE UPDATE OF id, project_id, kind, home_workspace_id, created_at ON agents
      WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.kind IS NOT OLD.kind
        OR NEW.home_workspace_id IS NOT OLD.home_workspace_id OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'an agent keeps its id, project, kind, home and creation time'); END;
    CREATE TRIGGER agents_inserted_once BEFORE INSERT ON agents
      WHEN EXISTS (SELECT 1 FROM agents WHERE id = NEW.id)
      BEGIN SELECT RAISE(ABORT, 'an agent is inserted once'); END;
    CREATE TRIGGER agents_kept BEFORE DELETE ON agents
      BEGIN SELECT RAISE(ABORT, 'an agent is archived, never deleted'); END;
    CREATE TRIGGER agents_home_live BEFORE INSERT ON agents
      WHEN (SELECT state FROM agent_workspaces WHERE id = NEW.home_workspace_id) NOT IN ${LIVE}
      BEGIN SELECT RAISE(ABORT, 'a new agent needs a home workspace that is being created or ready'); END;
    CREATE TRIGGER agents_restore_live BEFORE UPDATE OF archived ON agents
      WHEN NEW.archived = 0 AND (SELECT state FROM agent_workspaces WHERE id = NEW.home_workspace_id) NOT IN ${LIVE}
      BEGIN SELECT RAISE(ABORT, 'an agent whose home workspace is not live stays archived'); END;
    CREATE TRIGGER agent_workspaces_archive_agents AFTER UPDATE OF state ON agent_workspaces
      WHEN NEW.state NOT IN ${LIVE}
      BEGIN
        UPDATE agents SET archived = 1, archived_at = NEW.updated_at, updated_at = NEW.updated_at
          WHERE home_workspace_id = NEW.id AND archived = 0;
      END;

    ALTER TABLE agent_runs ADD COLUMN agent_id TEXT REFERENCES agents(id);
    CREATE INDEX agent_runs_by_agent ON agent_runs (agent_id) WHERE agent_id IS NOT NULL;
    CREATE TRIGGER agent_runs_inserted_once BEFORE INSERT ON agent_runs
      WHEN EXISTS (SELECT 1 FROM agent_runs WHERE id = NEW.id)
      BEGIN SELECT RAISE(ABORT, 'a run is inserted once'); END;
    CREATE TRIGGER agent_workspaces_inserted_once BEFORE INSERT ON agent_workspaces
      WHEN EXISTS (SELECT 1 FROM agent_workspaces WHERE id = NEW.id)
      BEGIN SELECT RAISE(ABORT, 'a workspace is inserted once'); END;
    CREATE TRIGGER agent_runs_agent_fixed BEFORE UPDATE OF agent_id ON agent_runs
      WHEN NEW.agent_id IS NOT OLD.agent_id
      BEGIN SELECT RAISE(ABORT, 'a run keeps the agent it started with'); END;
    CREATE TRIGGER agent_runs_agent_match BEFORE INSERT ON agent_runs
      WHEN NEW.agent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.agent_id
        AND home_workspace_id = NEW.workspace_id AND kind = NEW.kind AND archived = 0)
      BEGIN SELECT RAISE(ABORT, 'a run of an agent starts in its home workspace, with its kind, while it is not archived'); END;
  `,
};
