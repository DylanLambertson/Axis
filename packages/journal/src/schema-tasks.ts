// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Migration } from "@axis/audit";
import { SQL_RULES } from "./schema-pages.js";

/*
 * Tasks (ticket PV-T1 slice 1, `docs/design/extensibility.md` §6, `docs/design/tasks-store.md`): schema version 15,
 * forward-only. Tasks are Axis records in the journal.
 *
 * - `tasks`: one row per task of a project, at most 1,000. Its id, project, source and creation time never change. Status
 *   and assignee change in place; the text changes only by a new revision.
 *   - **`source`** is closed: `user`, `agent`, `plugin` or `integration`, and the first revision's author kind is the source.
 *   - **`untrusted`** says the task's text may hold text the user did not write: true for any source but the user, and set
 *     by the first revision from anyone but the user. It never goes back (there is no review of a task), so Start (a later
 *     slice) marks the text and taints the run (IAC-T source 5), and a task read is source 8. **`hop`** is the highest hop
 *     of any revision; it never goes down.
 *   - An assignee is an agent of the same project that is not archived, or a group of the same project. Assigning starts
 *     nothing.
 * - `task_revisions`: every text change is a new revision, never changed afterwards. Author is closed: `user`, `agent`,
 *   `plugin`, `integration` or `system`; the user writes at hop 0. At most 50 per task: the 51st deletes the oldest in the
 *   same statement, which cannot clear the task's sticky flags.
 * - `task_links`: typed links to a run, a workspace or a page of the same project, or a pull request number; at most 32 per
 *   task; inserted once, never changed, removable.
 * - Limits: title 1 to 200 characters (the agent-name rule), body at most 16,384 characters, 64 MiB of revision bytes per
 *   project, summed from each revision's stored `bytes` through a covering index, never from the bodies.
 * - Deleting a task deletes its revisions and links in the same statement.
 * - Every table refuses an INSERT of a key that exists, before any conflict clause (the PV-G1 lesson); text columns are
 *   NUL-safe (the PV-Q1 rules, `SQL_RULES`).
 */

const { ascii, noNul, id, pluginId, time, title } = SQL_RULES;

export const TASK_LIMITS = Object.freeze({
  tasksPerProject: 1_000,
  revisionsPerTask: 50,
  linksPerTask: 32,
  titleChars: 200,
  bodyChars: 16_384,
  projectBytes: 67_108_864,
});
const L = TASK_LIMITS;

/** The revision bytes a project holds, from the stored counts through the covering index `task_revisions_bytes`. */
export const projectTaskBytesSql = (projectExpr: string): string =>
  `(SELECT coalesce(sum(r.bytes), 0) FROM tasks t JOIN task_revisions r ON r.task_id = t.id WHERE t.project_id = ${projectExpr})`;
const TASK = (col: string, taskExpr = "NEW.task_id"): string => `(SELECT ${col} FROM tasks WHERE id = ${taskExpr})`;

export const TASKS_MIGRATION: Migration = {
  version: 15,
  sql: `
    CREATE TABLE tasks (
      id            TEXT PRIMARY KEY CHECK (${id("id")}),
      project_id    TEXT NOT NULL REFERENCES projects(id),
      source        TEXT NOT NULL CHECK (source IN ('user','agent','plugin','integration')),
      status        TEXT NOT NULL CHECK (status IN ('open','in_progress','blocked','done','cancelled')),
      assignee_kind TEXT CHECK (assignee_kind IS NULL OR assignee_kind IN ('agent','group')),
      assignee_id   TEXT CHECK (assignee_id IS NULL OR (${id("assignee_id")})),
      untrusted     INTEGER NOT NULL CHECK (untrusted IN (0, 1)),
      hop           INTEGER NOT NULL CHECK (hop BETWEEN 0 AND 8),
      last_seq      INTEGER NOT NULL CHECK (last_seq >= 0),
      created_at    TEXT NOT NULL CHECK (${time("created_at")}),
      updated_at    TEXT NOT NULL CHECK (${time("updated_at")}),
      CHECK ((assignee_kind IS NULL) = (assignee_id IS NULL)),
      CHECK (source = 'user' OR untrusted = 1)
    ) STRICT;
    CREATE INDEX tasks_by_project ON tasks (project_id, updated_at DESC, id);
    CREATE TRIGGER tasks_inserted_once BEFORE INSERT ON tasks
      WHEN EXISTS (SELECT 1 FROM tasks WHERE id = NEW.id)
      BEGIN SELECT RAISE(ABORT, 'a task is inserted once'); END;
    CREATE TRIGGER tasks_start_empty BEFORE INSERT ON tasks
      WHEN NEW.last_seq <> 0 OR NEW.hop <> 0 OR NEW.untrusted IS NOT (NEW.source <> 'user')
      BEGIN SELECT RAISE(ABORT, 'a task starts with no revision, hop 0, and untrusted unless the user is its source'); END;
    CREATE TRIGGER tasks_per_project BEFORE INSERT ON tasks
      WHEN (SELECT count(*) FROM tasks WHERE project_id = NEW.project_id) >= ${L.tasksPerProject}
      BEGIN SELECT RAISE(ABORT, 'a project holds at most ${L.tasksPerProject} tasks'); END;
    CREATE TRIGGER tasks_fixed BEFORE UPDATE OF id, project_id, source, created_at ON tasks
      WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.source IS NOT OLD.source OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'a task keeps its id, project, source and creation time'); END;
    CREATE TRIGGER tasks_sticky BEFORE UPDATE OF untrusted, hop ON tasks
      WHEN NEW.untrusted < OLD.untrusted OR NEW.hop < OLD.hop
      BEGIN SELECT RAISE(ABORT, 'a task''s untrusted flag and hop never go back'); END;
    CREATE TRIGGER tasks_seq_is_newest BEFORE UPDATE OF last_seq ON tasks
      WHEN NEW.last_seq IS NOT (SELECT coalesce(max(seq), 0) FROM task_revisions WHERE task_id = NEW.id)
      BEGIN SELECT RAISE(ABORT, 'a task''s last revision number is its newest revision'); END;
    CREATE TRIGGER tasks_assignee_insert BEFORE INSERT ON tasks
      WHEN NEW.assignee_kind IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'a new task has no assignee; assigning is its own step'); END;
    CREATE TRIGGER tasks_assignee_in_project BEFORE UPDATE OF assignee_kind, assignee_id ON tasks
      WHEN NEW.assignee_kind IS NOT NULL AND NOT (
        (NEW.assignee_kind = 'agent' AND EXISTS (SELECT 1 FROM agents WHERE id = NEW.assignee_id AND project_id = NEW.project_id AND archived = 0))
        OR (NEW.assignee_kind = 'group' AND EXISTS (SELECT 1 FROM agent_groups WHERE id = NEW.assignee_id AND project_id = NEW.project_id)))
      BEGIN SELECT RAISE(ABORT, 'an assignee is a live agent or a group of the task''s project'); END;

    CREATE TABLE task_revisions (
      task_id     TEXT NOT NULL REFERENCES tasks(id),
      seq         INTEGER NOT NULL CHECK (seq >= 1),
      title       TEXT NOT NULL CHECK (${title("title")}),
      body        TEXT NOT NULL CHECK (length(body) <= ${L.bodyChars} AND ${noNul("body")}),
      bytes       INTEGER NOT NULL CHECK (bytes = length(CAST(title AS BLOB)) + length(CAST(body AS BLOB))),
      author_kind TEXT NOT NULL CHECK (author_kind IN ('user','agent','plugin','integration','system')),
      author_id   TEXT,
      hop         INTEGER NOT NULL CHECK (hop BETWEEN 0 AND 8),
      created_at  TEXT NOT NULL CHECK (${time("created_at")}),
      CHECK (author_kind NOT IN ('user','system') OR author_id IS NULL),
      CHECK (author_kind NOT IN ('agent','integration') OR (author_id IS NOT NULL AND ${id("author_id")})),
      CHECK (author_kind <> 'plugin' OR (author_id IS NOT NULL AND ${pluginId("author_id")})),
      CHECK (author_kind <> 'user' OR hop = 0),
      PRIMARY KEY (task_id, seq)
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX task_revisions_bytes ON task_revisions (task_id, bytes);
    CREATE TRIGGER task_revisions_inserted_once BEFORE INSERT ON task_revisions
      WHEN EXISTS (SELECT 1 FROM task_revisions WHERE task_id = NEW.task_id AND seq = NEW.seq)
      BEGIN SELECT RAISE(ABORT, 'a revision is inserted once'); END;
    CREATE TRIGGER task_revisions_next BEFORE INSERT ON task_revisions
      WHEN NEW.seq IS NOT ${TASK("last_seq + 1")}
      BEGIN SELECT RAISE(ABORT, 'a revision takes its task''s next number'); END;
    CREATE TRIGGER task_revisions_first_is_source BEFORE INSERT ON task_revisions
      WHEN NEW.seq = 1 AND NEW.author_kind IS NOT ${TASK("source")}
      BEGIN SELECT RAISE(ABORT, 'a task''s first revision is written by its source'); END;
    CREATE TRIGGER task_revisions_project_bytes BEFORE INSERT ON task_revisions
      WHEN ${projectTaskBytesSql(TASK("project_id"))} + NEW.bytes > ${L.projectBytes}
      BEGIN SELECT RAISE(ABORT, 'a project holds at most 64 MiB of task text'); END;
    CREATE TRIGGER task_revisions_fixed BEFORE UPDATE ON task_revisions
      BEGIN SELECT RAISE(ABORT, 'a revision never changes'); END;
    CREATE TRIGGER task_revisions_advance AFTER INSERT ON task_revisions
      BEGIN
        UPDATE tasks SET last_seq = NEW.seq, updated_at = NEW.created_at,
          untrusted = max(untrusted, NEW.author_kind <> 'user'), hop = max(hop, NEW.hop)
          WHERE id = NEW.task_id;
        DELETE FROM task_revisions WHERE task_id = NEW.task_id
          AND (SELECT count(*) FROM task_revisions WHERE task_id = NEW.task_id) > ${L.revisionsPerTask}
          AND seq = (SELECT min(seq) FROM task_revisions WHERE task_id = NEW.task_id);
      END;
    CREATE TRIGGER task_revisions_kept BEFORE DELETE ON task_revisions
      WHEN EXISTS (SELECT 1 FROM tasks WHERE id = OLD.task_id) AND NOT (
        (SELECT count(*) FROM task_revisions WHERE task_id = OLD.task_id) > ${L.revisionsPerTask}
        AND OLD.seq = (SELECT min(seq) FROM task_revisions WHERE task_id = OLD.task_id))
      BEGIN SELECT RAISE(ABORT, 'a revision is deleted only as the oldest past the cap, or with its task'); END;

    CREATE TABLE task_links (
      task_id    TEXT NOT NULL REFERENCES tasks(id),
      kind       TEXT NOT NULL CHECK (kind IN ('run','workspace','page','pr')),
      target     TEXT NOT NULL CHECK (
                   (kind <> 'pr' AND ${id("target")})
                   OR (kind = 'pr' AND length(target) BETWEEN 1 AND 10 AND substr(target, 1, 1) GLOB '[1-9]' AND target NOT GLOB '*[^0-9]*' AND ${ascii("target")})),
      created_at TEXT NOT NULL CHECK (${time("created_at")}),
      PRIMARY KEY (task_id, kind, target)
    ) STRICT, WITHOUT ROWID;
    CREATE TRIGGER task_links_inserted_once BEFORE INSERT ON task_links
      WHEN EXISTS (SELECT 1 FROM task_links WHERE task_id = NEW.task_id AND kind = NEW.kind AND target = NEW.target)
      BEGIN SELECT RAISE(ABORT, 'a link is inserted once'); END;
    CREATE TRIGGER task_links_per_task BEFORE INSERT ON task_links
      WHEN (SELECT count(*) FROM task_links WHERE task_id = NEW.task_id) >= ${L.linksPerTask}
      BEGIN SELECT RAISE(ABORT, 'a task holds at most ${L.linksPerTask} links'); END;
    CREATE TRIGGER task_links_same_project BEFORE INSERT ON task_links
      WHEN NEW.kind <> 'pr' AND NOT (
        (NEW.kind = 'workspace' AND EXISTS (SELECT 1 FROM agent_workspaces WHERE id = NEW.target AND project_id = ${TASK("project_id")}))
        OR (NEW.kind = 'run' AND EXISTS (SELECT 1 FROM agent_runs r JOIN agent_workspaces w ON w.id = r.workspace_id
              WHERE r.id = NEW.target AND w.project_id = ${TASK("project_id")}))
        OR (NEW.kind = 'page' AND EXISTS (SELECT 1 FROM pages WHERE id = NEW.target AND project_id = ${TASK("project_id")})))
      BEGIN SELECT RAISE(ABORT, 'a link names a run, workspace or page of the task''s project'); END;
    CREATE TRIGGER task_links_fixed BEFORE UPDATE ON task_links
      BEGIN SELECT RAISE(ABORT, 'a link never changes'); END;

    CREATE TRIGGER tasks_delete_contents AFTER DELETE ON tasks
      BEGIN
        DELETE FROM task_links WHERE task_id = OLD.id;
        DELETE FROM task_revisions WHERE task_id = OLD.id;
      END;
  `,
};
