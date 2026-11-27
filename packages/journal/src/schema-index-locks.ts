// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Migration } from "@axis/audit";
import { SQL_RULES } from "./schema-pages.js";

/*
 * The index locks Axis holds (ticket DC-0b, RR-98; `docs/design/own-shell-plan.md` DC-0b): schema version 21, forward-only.
 * The post-commit index refresh (DC-0, `@axis/git-ops` `indexRefresh.ts`) holds `<git-path index>.lock` for one copy and
 * rewrite of the index. A crash meanwhile leaves the lock, which blocks the user's git. Git's own lock looks the same (an index
 * copy) and takes no lock a process can probe, so the only safe way to tell Axis's lock apart is a record made while holding it.
 *
 * - One row per lock path: its `dev`, `ino` and `mtime_ns` (decimal text: they can exceed the safe integer range), taken right
 *   after the `O_EXCL` open and again after git rewrote the lock (a new inode), and deleted after the rename or the unlink.
 * - A startup sweep removes a lock only when the file at that path has the same `dev` and `ino` and an `mtime` no later than
 *   recorded; a lock git made later is a new file and is never touched. Then the row is deleted.
 * - Inserted once per path by any verb; updated to re-record; deleted when done. The path is absolute, ends in `index.lock`,
 *   holds no NUL and is at most 4,096 characters.
 */

const { time } = SQL_RULES;
const decimal = (c: string): string => `length(${c}) BETWEEN 1 AND 20 AND ${c} NOT GLOB '*[^0-9]*'`;

export const INDEX_LOCKS_MIGRATION: Migration = {
  version: 21,
  sql: `
    CREATE TABLE index_locks (
      path        TEXT PRIMARY KEY CHECK (
                    instr(path, char(0)) = 0 AND length(path) BETWEEN 11 AND 4096
                    AND (substr(path, 1, 1) = '/' OR path GLOB '[A-Za-z]:\\*' OR substr(path, 1, 2) = '\\\\')
                    AND (path GLOB '*/index.lock' OR path GLOB '*\\index.lock')),
      dev         TEXT NOT NULL CHECK (${decimal("dev")}),
      ino         TEXT NOT NULL CHECK (${decimal("ino")}),
      mtime_ns    TEXT NOT NULL CHECK (${decimal("mtime_ns")}),
      recorded_at TEXT NOT NULL CHECK (${time("recorded_at")})
    ) STRICT, WITHOUT ROWID;
    CREATE TRIGGER index_locks_once BEFORE INSERT ON index_locks
      WHEN EXISTS (SELECT 1 FROM index_locks WHERE path = NEW.path)
      BEGIN SELECT RAISE(ABORT, 'an index lock is recorded once: update it'); END;
  `,
};
