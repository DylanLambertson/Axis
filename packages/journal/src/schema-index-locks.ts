// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Migration } from "@axis/audit";
import { SQL_RULES } from "./schema-pages.js";

/*
 * The index locks Axis holds (ticket DC-0b, RR-98; `docs/design/own-shell-plan.md` DC-0b): schema version 21, forward-only.
 * The post-commit index refresh (DC-0, `@axis/git-ops` `indexRefresh.ts`) holds `<git-path index>.lock` while git edits a
 * private copy of the index. A crash meanwhile leaves the lock, which blocks the user's git. Git's own lock cannot be told
 * apart by content and takes no lock a process can probe, so the only safe way to tell Axis's lock apart is a record made
 * while holding it.
 *
 * - One row per lock path: its `dev`, `ino` and `ctime_ns` (decimal text: they can exceed the safe integer range), taken once
 *   right after the `O_EXCL` open (the lock is held open and never written, so they never change), deleted when the lock is
 *   gone. The ctime is set by the kernel only: a reused inode number at the same path gets a newer one, and `utimes` cannot
 *   set it back.
 * - A startup sweep removes a lock only when the file at that path is a regular file with exactly these three values, and only
 *   at a registered repository's index path; then the row is deleted.
 * - Inserted once per path by any verb; updated when a later refresh records the same path again; deleted when done. The
 *   path is absolute, ends in `index.lock`, holds no NUL and is at most 4,096 characters.
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
      ctime_ns    TEXT NOT NULL CHECK (${decimal("ctime_ns")}),
      recorded_at TEXT NOT NULL CHECK (${time("recorded_at")})
    ) STRICT, WITHOUT ROWID;
    CREATE TRIGGER index_locks_once BEFORE INSERT ON index_locks
      WHEN EXISTS (SELECT 1 FROM index_locks WHERE path = NEW.path)
      BEGIN SELECT RAISE(ABORT, 'an index lock is recorded once: update it'); END;
  `,
};
