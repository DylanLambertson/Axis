// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Migration } from "@axis/audit";
import { NAME_REFUSED_RANGES } from "./schema-agents.js";

/*
 * Pages (ticket PV-Q1 slice 1, ADR 0010, docs/design/pages-store.md): schema version 14, forward-only. Pages are Axis
 * records in the journal, never files in a repository.
 *
 * - `pages`: one row per page of a project, at most 500 per project. Its id, project and creation time never change;
 *   `last_seq` is the number of its newest version and moves only with a new version.
 * - `page_versions`: every save is a new version; a version is never changed afterwards (title, body, author, hop, trust
 *   flags, origin and time are fixed), except that the user may mark it reviewed once (`reviewed_at`, NULL to a time).
 *   - **Author** is a closed set: `user`, `agent` (an agent id), `plugin` (a plugin id, ADR 0008) or `system`.
 *   - **`untrusted`** says the version may hold text the user did not write (the taint rule IAC-T, source 4). A version by
 *     anyone but the user is untrusted. A user edit stays untrusted while the version it edits is untrusted and not
 *     reviewed, because the earlier text is still there (ADR 0010 decision 4). **`hop`** is the writing run's hop for a
 *     non-user author and the inherited hop for an untrusted user edit, else 0.
 *   - **A restore copies its source**: title, body, author, hop and `untrusted`, and records `restored_from`. Restoring an
 *     agent's text therefore never turns it into the user's; the reviewed mark is not copied.
 *   - The triggers check every derived value against the version it follows, so no writer can launder a page.
 *   - At most 100 versions per page: inserting the 101st deletes the oldest in the same statement. No other version is
 *     ever deleted while its page exists.
 * - `page_attachments`: raster images only (PNG, JPEG, GIF, WebP), the type checked against the file's leading bytes;
 *   at most 20 per page, 5 MiB each; added by the user only; never changed.
 * - Limits (ADR 0010 decision 1): body 256 KiB of UTF-8, title 1 to 200 characters, 200 MiB of version and attachment
 *   bytes per project. A write over a limit is refused, never cut.
 * - Deleting a page deletes its versions and attachments in the same statement; no project removal exists yet.
 * - Every table refuses an INSERT of an id that exists: `INSERT OR REPLACE` would delete the old row without firing a
 *   DELETE or UPDATE trigger, and the guard fires before any conflict clause, so `OR IGNORE` and upserts abort too (the
 *   PV-G1 lesson).
 * - SQLite's text functions and GLOB stop at a NUL. ASCII columns check that their byte length equals their character
 *   length; titles and bodies refuse a NUL byte through their blob form.
 */

type Range = number | readonly [number, number];
const BAD_TITLE_CHARS = `'*[' || ${(NAME_REFUSED_RANGES as readonly Range[]).map((r) => (typeof r === "number" ? `char(${r})` : `char(${r[0]}) || '-' || char(${r[1]})`)).join(" || ")} || ']*'`;
const ascii = (col: string): string => `length(CAST(${col} AS BLOB)) = length(${col})`;
const noNul = (col: string): string => `instr(CAST(${col} AS BLOB), X'00') = 0`;
const id = (col: string): string =>
  `length(${col}) BETWEEN 1 AND 64 AND substr(${col}, 1, 1) GLOB '[A-Za-z0-9]' AND ${col} NOT GLOB '*[^A-Za-z0-9_-]*' AND ${ascii(col)}`;
const pluginId = (col: string): string =>
  `length(${col}) BETWEEN 1 AND 64 AND substr(${col}, 1, 1) GLOB '[a-z]' AND ${col} NOT GLOB '*[^a-z0-9.-]*' AND ${col} NOT GLOB '*..*' AND ${col} NOT GLOB '*.' AND ${col} NOT GLOB '*.[^a-z]*' AND ${ascii(col)}`;
const time = (col: string): string => `length(${col}) BETWEEN 20 AND 30 AND ${ascii(col)}`;
const title = (col: string): string =>
  `length(${col}) BETWEEN 1 AND 200 AND ${col} = trim(${col}) AND ${noNul(col)} AND ${col} NOT GLOB (${BAD_TITLE_CHARS})`;

export const PAGE_LIMITS = Object.freeze({
  pagesPerProject: 500,
  versionsPerPage: 100,
  bodyBytes: 262_144,
  titleChars: 200,
  attachmentsPerPage: 20,
  attachmentBytes: 5_242_880,
  projectBytes: 209_715_200,
});

const L = PAGE_LIMITS;
const PREV = (col: string): string => `(SELECT ${col} FROM page_versions WHERE page_id = NEW.page_id AND seq = NEW.seq - 1)`;
const PROJECT_OF = (pageExpr: string): string => `(SELECT project_id FROM pages WHERE id = ${pageExpr})`;
const PROJECT_BYTES = (pageExpr: string): string => `(
        (SELECT coalesce(sum(length(CAST(v.title AS BLOB)) + length(CAST(v.body AS BLOB))), 0)
           FROM page_versions v JOIN pages p ON p.id = v.page_id WHERE p.project_id = ${PROJECT_OF(pageExpr)})
      + (SELECT coalesce(sum(length(a.bytes)), 0)
           FROM page_attachments a JOIN pages p ON p.id = a.page_id WHERE p.project_id = ${PROJECT_OF(pageExpr)}))`;
const MAGIC = `(
        (media_type = 'image/png' AND substr(bytes, 1, 8) = X'89504E470D0A1A0A')
     OR (media_type = 'image/jpeg' AND substr(bytes, 1, 3) = X'FFD8FF')
     OR (media_type = 'image/gif' AND substr(bytes, 1, 6) IN (X'474946383761', X'474946383961'))
     OR (media_type = 'image/webp' AND substr(bytes, 1, 4) = X'52494646' AND substr(bytes, 9, 4) = X'57454250'))`;

export const PAGES_MIGRATION: Migration = {
  version: 14,
  sql: `
    CREATE TABLE pages (
      id         TEXT PRIMARY KEY CHECK (${id("id")}),
      project_id TEXT NOT NULL REFERENCES projects(id),
      last_seq   INTEGER NOT NULL CHECK (last_seq >= 0),
      created_at TEXT NOT NULL CHECK (${time("created_at")}),
      updated_at TEXT NOT NULL CHECK (${time("updated_at")})
    ) STRICT;
    CREATE INDEX pages_by_project ON pages (project_id, updated_at DESC, id);
    CREATE TRIGGER pages_inserted_once BEFORE INSERT ON pages
      WHEN EXISTS (SELECT 1 FROM pages WHERE id = NEW.id)
      BEGIN SELECT RAISE(ABORT, 'a page is inserted once'); END;
    CREATE TRIGGER pages_start_empty BEFORE INSERT ON pages
      WHEN NEW.last_seq <> 0
      BEGIN SELECT RAISE(ABORT, 'a page starts with no version'); END;
    CREATE TRIGGER pages_per_project BEFORE INSERT ON pages
      WHEN (SELECT count(*) FROM pages WHERE project_id = NEW.project_id) >= ${L.pagesPerProject}
      BEGIN SELECT RAISE(ABORT, 'a project holds at most ${L.pagesPerProject} pages'); END;
    CREATE TRIGGER pages_fixed BEFORE UPDATE OF id, project_id, created_at ON pages
      WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'a page keeps its id, project and creation time'); END;
    CREATE TRIGGER pages_seq_is_newest BEFORE UPDATE OF last_seq ON pages
      WHEN NEW.last_seq IS NOT (SELECT coalesce(max(seq), 0) FROM page_versions WHERE page_id = NEW.id)
      BEGIN SELECT RAISE(ABORT, 'a page''s last version number is its newest version'); END;

    CREATE TABLE page_versions (
      page_id       TEXT NOT NULL REFERENCES pages(id),
      seq           INTEGER NOT NULL CHECK (seq >= 1),
      title         TEXT NOT NULL CHECK (${title("title")}),
      body          TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= ${L.bodyBytes} AND ${noNul("body")}),
      author_kind   TEXT NOT NULL CHECK (author_kind IN ('user','agent','plugin','system')),
      author_id     TEXT,
      hop           INTEGER NOT NULL CHECK (hop BETWEEN 0 AND 8),
      untrusted     INTEGER NOT NULL CHECK (untrusted IN (0, 1)),
      restored_from INTEGER CHECK (restored_from IS NULL OR restored_from >= 1),
      reviewed_at   TEXT CHECK (reviewed_at IS NULL OR (${time("reviewed_at")})),
      created_at    TEXT NOT NULL CHECK (${time("created_at")}),
      CHECK (author_kind NOT IN ('user','system') OR author_id IS NULL),
      CHECK (author_kind <> 'agent' OR (author_id IS NOT NULL AND ${id("author_id")})),
      CHECK (author_kind <> 'plugin' OR (author_id IS NOT NULL AND ${pluginId("author_id")})),
      CHECK (author_kind = 'user' OR untrusted = 1),
      CHECK (untrusted = 1 OR hop = 0),
      CHECK (reviewed_at IS NULL OR untrusted = 1),
      CHECK (restored_from IS NULL OR restored_from < seq),
      PRIMARY KEY (page_id, seq)
    ) STRICT, WITHOUT ROWID;
    CREATE TRIGGER page_versions_inserted_once BEFORE INSERT ON page_versions
      WHEN EXISTS (SELECT 1 FROM page_versions WHERE page_id = NEW.page_id AND seq = NEW.seq)
      BEGIN SELECT RAISE(ABORT, 'a version is inserted once'); END;
    CREATE TRIGGER page_versions_next BEFORE INSERT ON page_versions
      WHEN NEW.seq IS NOT (SELECT last_seq + 1 FROM pages WHERE id = NEW.page_id)
      BEGIN SELECT RAISE(ABORT, 'a version takes its page''s next number'); END;
    CREATE TRIGGER page_versions_unreviewed BEFORE INSERT ON page_versions
      WHEN NEW.reviewed_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'a version is marked reviewed only after it exists'); END;
    CREATE TRIGGER page_versions_user_edit BEFORE INSERT ON page_versions
      WHEN NEW.restored_from IS NULL AND NEW.author_kind = 'user' AND (
        NEW.untrusted IS NOT coalesce(${PREV("untrusted = 1 AND reviewed_at IS NULL")}, 0)
        OR NEW.hop IS NOT (CASE WHEN NEW.untrusted = 1 THEN ${PREV("hop")} ELSE 0 END))
      BEGIN SELECT RAISE(ABORT, 'a user edit keeps the untrusted text and hop of the version it edits until that is reviewed'); END;
    CREATE TRIGGER page_versions_restore_copies BEFORE INSERT ON page_versions
      WHEN NEW.restored_from IS NOT NULL AND NOT EXISTS (SELECT 1 FROM page_versions s
        WHERE s.page_id = NEW.page_id AND s.seq = NEW.restored_from AND s.title IS NEW.title AND s.body IS NEW.body
          AND s.author_kind IS NEW.author_kind AND s.author_id IS NEW.author_id AND s.hop IS NEW.hop AND s.untrusted IS NEW.untrusted)
      BEGIN SELECT RAISE(ABORT, 'a restore copies its source version, author and trust included'); END;
    CREATE TRIGGER page_versions_project_bytes BEFORE INSERT ON page_versions
      WHEN ${PROJECT_BYTES("NEW.page_id")} + length(CAST(NEW.title AS BLOB)) + length(CAST(NEW.body AS BLOB)) > ${L.projectBytes}
      BEGIN SELECT RAISE(ABORT, 'a project holds at most 200 MiB of pages and attachments'); END;
    CREATE TRIGGER page_versions_fixed BEFORE UPDATE ON page_versions
      WHEN NEW.page_id IS NOT OLD.page_id OR NEW.seq IS NOT OLD.seq OR NEW.title IS NOT OLD.title OR NEW.body IS NOT OLD.body
        OR NEW.author_kind IS NOT OLD.author_kind OR NEW.author_id IS NOT OLD.author_id OR NEW.hop IS NOT OLD.hop
        OR NEW.untrusted IS NOT OLD.untrusted OR NEW.restored_from IS NOT OLD.restored_from OR NEW.created_at IS NOT OLD.created_at
        OR (OLD.reviewed_at IS NOT NULL AND NEW.reviewed_at IS NOT OLD.reviewed_at)
      BEGIN SELECT RAISE(ABORT, 'a version never changes; only an unreviewed one can be marked reviewed, once'); END;
    CREATE TRIGGER page_versions_advance AFTER INSERT ON page_versions
      BEGIN
        UPDATE pages SET last_seq = NEW.seq, updated_at = NEW.created_at WHERE id = NEW.page_id;
        DELETE FROM page_versions WHERE page_id = NEW.page_id
          AND (SELECT count(*) FROM page_versions WHERE page_id = NEW.page_id) > ${L.versionsPerPage}
          AND seq = (SELECT min(seq) FROM page_versions WHERE page_id = NEW.page_id);
      END;
    CREATE TRIGGER page_versions_kept BEFORE DELETE ON page_versions
      WHEN EXISTS (SELECT 1 FROM pages WHERE id = OLD.page_id) AND NOT (
        (SELECT count(*) FROM page_versions WHERE page_id = OLD.page_id) > ${L.versionsPerPage}
        AND OLD.seq = (SELECT min(seq) FROM page_versions WHERE page_id = OLD.page_id))
      BEGIN SELECT RAISE(ABORT, 'a version is deleted only as the oldest past the cap, or with its page'); END;

    CREATE TABLE page_attachments (
      id         TEXT PRIMARY KEY CHECK (${id("id")}),
      page_id    TEXT NOT NULL REFERENCES pages(id),
      media_type TEXT NOT NULL CHECK (media_type IN ('image/png','image/jpeg','image/gif','image/webp')),
      bytes      BLOB NOT NULL CHECK (length(bytes) BETWEEN 12 AND ${L.attachmentBytes}),
      sha256     TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*' AND ${ascii("sha256")}),
      created_by TEXT NOT NULL CHECK (created_by = 'user'),
      created_at TEXT NOT NULL CHECK (${time("created_at")}),
      CHECK ${MAGIC}
    ) STRICT;
    CREATE INDEX page_attachments_by_page ON page_attachments (page_id, created_at, id);
    CREATE TRIGGER page_attachments_inserted_once BEFORE INSERT ON page_attachments
      WHEN EXISTS (SELECT 1 FROM page_attachments WHERE id = NEW.id)
      BEGIN SELECT RAISE(ABORT, 'an attachment is inserted once'); END;
    CREATE TRIGGER page_attachments_per_page BEFORE INSERT ON page_attachments
      WHEN (SELECT count(*) FROM page_attachments WHERE page_id = NEW.page_id) >= ${L.attachmentsPerPage}
      BEGIN SELECT RAISE(ABORT, 'a page holds at most ${L.attachmentsPerPage} attachments'); END;
    CREATE TRIGGER page_attachments_project_bytes BEFORE INSERT ON page_attachments
      WHEN ${PROJECT_BYTES("NEW.page_id")} + length(NEW.bytes) > ${L.projectBytes}
      BEGIN SELECT RAISE(ABORT, 'a project holds at most 200 MiB of pages and attachments'); END;
    CREATE TRIGGER page_attachments_fixed BEFORE UPDATE ON page_attachments
      BEGIN SELECT RAISE(ABORT, 'an attachment never changes'); END;

    CREATE TRIGGER pages_delete_contents AFTER DELETE ON pages
      BEGIN
        DELETE FROM page_attachments WHERE page_id = OLD.id;
        DELETE FROM page_versions WHERE page_id = OLD.id;
      END;
  `,
};
