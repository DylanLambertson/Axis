// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Migration } from "@axis/audit";
import { TASK_LIMITS } from "./schema-tasks.js";

/*
 * The user's newest revision is never evicted (ticket PV-T1 slice 3, `docs/design/tasks-slice3.md` §3.2, RR-93): schema
 * version 19, forward-only. It replaces the two revision-cap triggers of version 15 and changes no data.
 *
 * - **The 51st revision deletes the oldest revision other than the user's newest** (`max(seq)` among the task's revisions
 *   whose author is `user`). A task therefore keeps the user's last words however many revisions others write after them,
 *   and still holds at most 50.
 * - The comparison is `seq IS NOT (…)`: for a task with no user revision the subquery is NULL, `IS NOT NULL` holds for every
 *   row, and the oldest is pruned as before (a `<>` would match no row and stop pruning).
 * - `task_revisions_kept` allows exactly that deletion, or any deletion once the task row is gone (deleting a task removes
 *   all its revisions in the same statement, as before).
 */

const CAP = TASK_LIMITS.revisionsPerTask;
/** The seq the cap may delete from task `taskExpr`: the oldest that is not the user's newest. */
const evictable = (taskExpr: string): string =>
  `(SELECT min(seq) FROM task_revisions WHERE task_id = ${taskExpr} AND seq IS NOT ` +
  `(SELECT max(seq) FROM task_revisions WHERE task_id = ${taskExpr} AND author_kind = 'user'))`;

export const TASKS_KEEP_USER_MIGRATION: Migration = {
  version: 19,
  sql: `
    DROP TRIGGER task_revisions_advance;
    DROP TRIGGER task_revisions_kept;
    CREATE TRIGGER task_revisions_advance AFTER INSERT ON task_revisions
      BEGIN
        UPDATE tasks SET last_seq = NEW.seq, updated_at = NEW.created_at,
          untrusted = max(untrusted, NEW.author_kind <> 'user'), hop = max(hop, NEW.hop)
          WHERE id = NEW.task_id;
        DELETE FROM task_revisions WHERE task_id = NEW.task_id
          AND (SELECT count(*) FROM task_revisions WHERE task_id = NEW.task_id) > ${CAP}
          AND seq = ${evictable("NEW.task_id")};
      END;
    CREATE TRIGGER task_revisions_kept BEFORE DELETE ON task_revisions
      WHEN EXISTS (SELECT 1 FROM tasks WHERE id = OLD.task_id) AND NOT (
        (SELECT count(*) FROM task_revisions WHERE task_id = OLD.task_id) > ${CAP}
        AND OLD.seq = ${evictable("OLD.task_id")})
      BEGIN SELECT RAISE(ABORT, 'a revision is deleted only as the oldest past the cap other than the user''s newest, or with its task'); END;
  `,
};
