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
 *     its project. Restoring needs a home workspace that is not going or gone.
 *   - A workspace that starts going away (REMOVING, REMOVED or FAILED) archives every live agent it is home to, in the
 *     same statement, so no live agent ever points at a removed workspace whatever code path removes it (ADR 0006
 *     decision 5). The daemon writes the audit events for that archive (PV-G3); the schema only keeps the invariant.
 *   - `created_by` is always `user`: agent and group writes are user-only (ADR 0006 decision 10). Group membership
 *     feeds the messaging send policy (`accepts_from: group`), which is why it is constrained here as well.
 * - `agent_runs.agent_id`: NULL for every run recorded before this version and for runs started without an agent. It is
 *   fixed at insert. A run with an agent runs in that agent's home workspace, has the agent's kind, and is never started
 *   for an archived agent. "From 1c runs start only from an agent" is the daemon's rule (PV-G4), not this schema's:
 *   today's run paths insert runs with no agent.
 *
 * Ids follow the protocol's journal id (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, `messages-wire.ts`), so a messaging
 * principal `agent:<id>` stays within its 128 characters. Names are 1 to 64 characters with no leading or trailing
 * space, no control character and no bidirectional control.
 */

const id = (col: string): string =>
  `length(${col}) <= 64 AND substr(${col}, 1, 1) GLOB '[A-Za-z0-9]' AND ${col} NOT GLOB '*[^A-Za-z0-9_-]*'`;
// C0 controls, DEL, and the bidirectional controls (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069).
const BAD_NAME_CHARS = `'*[' || char(1) || '-' || char(31) || char(127) || char(1564) || char(8206) || char(8207) || char(8234) || '-' || char(8238) || char(8294) || '-' || char(8297) || ']*'`;
const name = (col: string): string =>
  `length(${col}) BETWEEN 1 AND 64 AND ${col} = trim(${col}) AND instr(${col}, char(0)) = 0 AND ${col} NOT GLOB (${BAD_NAME_CHARS})`;
const GONE = `('REMOVING','REMOVED','FAILED')`;

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
    CREATE UNIQUE INDEX agents_live_name ON agents (project_id, name) WHERE archived = 0;
    CREATE INDEX agents_by_home ON agents (home_workspace_id);
    CREATE INDEX agents_by_group ON agents (group_id) WHERE group_id IS NOT NULL;
    CREATE TRIGGER agents_fixed BEFORE UPDATE OF id, project_id, kind, home_workspace_id, created_at ON agents
      WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.kind IS NOT OLD.kind
        OR NEW.home_workspace_id IS NOT OLD.home_workspace_id OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'an agent keeps its id, project, kind, home and creation time'); END;
    CREATE TRIGGER agents_kept BEFORE DELETE ON agents
      BEGIN SELECT RAISE(ABORT, 'an agent is archived, never deleted'); END;
    CREATE TRIGGER agents_home_live BEFORE INSERT ON agents
      WHEN (SELECT state FROM agent_workspaces WHERE id = NEW.home_workspace_id) NOT IN ('CREATING','READY')
      BEGIN SELECT RAISE(ABORT, 'a new agent needs a home workspace that is being created or ready'); END;
    CREATE TRIGGER agents_restore_live BEFORE UPDATE OF archived ON agents
      WHEN NEW.archived = 0 AND (SELECT state FROM agent_workspaces WHERE id = NEW.home_workspace_id) IN ${GONE}
      BEGIN SELECT RAISE(ABORT, 'an agent whose home workspace is gone stays archived'); END;
    CREATE TRIGGER agent_workspaces_archive_agents AFTER UPDATE OF state ON agent_workspaces
      WHEN NEW.state IN ${GONE}
      BEGIN
        UPDATE agents SET archived = 1, archived_at = NEW.updated_at, updated_at = NEW.updated_at
          WHERE home_workspace_id = NEW.id AND archived = 0;
      END;

    ALTER TABLE agent_runs ADD COLUMN agent_id TEXT REFERENCES agents(id);
    CREATE INDEX agent_runs_by_agent ON agent_runs (agent_id) WHERE agent_id IS NOT NULL;
    CREATE TRIGGER agent_runs_agent_fixed BEFORE UPDATE OF agent_id ON agent_runs
      WHEN NEW.agent_id IS NOT OLD.agent_id
      BEGIN SELECT RAISE(ABORT, 'a run keeps the agent it started with'); END;
    CREATE TRIGGER agent_runs_agent_match BEFORE INSERT ON agent_runs
      WHEN NEW.agent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agents WHERE id = NEW.agent_id
        AND home_workspace_id = NEW.workspace_id AND kind = NEW.kind AND archived = 0)
      BEGIN SELECT RAISE(ABORT, 'a run of an agent starts in its home workspace, with its kind, while it is not archived'); END;
  `,
};
