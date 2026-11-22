// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AuditLog, openDatabase, runMigrations, schemaVersion, type DatabaseSync } from "@axis/audit";
import { JOURNAL_MIGRATIONS, JOURNAL_SCHEMA_VERSION, Journal, PAGE_LIMITS, projectBytesSql } from "../src/index.js";

// Pages (ticket PV-Q1 slice 1, ADR 0010): schema version 14, the table rules. Every rule has a refusing case next to the
// closest accepted value, and every insert verb is tried against every insert-once guard. The store is page-store.test.ts.

const T = "2026-11-22T00:00:00.000Z";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function setup(): { db: DatabaseSync; journal: Journal } {
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  journal.registerProject({ id: "p1", path: "/repo/one", displayName: "One", trusted: false, actor: "user" });
  journal.registerProject({ id: "p2", path: "/repo/two", displayName: "Two", trusted: false, actor: "user" });
  return { db, journal };
}
type Val = string | number | null | Uint8Array;
type Row = Record<string, Val>;
function insert(db: DatabaseSync, table: string, row: Row, verb = "INSERT", tail = ""): void {
  const cols = Object.keys(row);
  db.prepare(`${verb} INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})${tail}`).run(...Object.values(row));
}
const page = (over: Row = {}): Row => ({ id: "pg1", project_id: "p1", last_seq: 0, created_at: T, updated_at: T, ...over });
/** A version row; `bytes` is the stored count of its title and body unless the case overrides it. */
const ver = (over: Row = {}): Row => {
  const r: Row = { page_id: "pg1", seq: 1, title: "Notes", body: "# Hi", author_kind: "user", author_id: null, hop: 0, untrusted: 0, restored_from: null, created_at: T, ...over };
  return "bytes" in over ? r : { ...r, bytes: Buffer.byteLength(String(r["title"])) + Buffer.byteLength(String(r["body"])) };
};
const att = (over: Row = {}): Row => {
  const r: Row = { id: "at1", page_id: "pg1", media_type: "image/png", bytes: PNG, sha256: "a".repeat(64), created_by: "user", created_at: T, ...over };
  return "size" in over ? r : { ...r, size: (r["bytes"] as Uint8Array).length };
};
const refused = (f: () => void, what: string): void => assert.throws(f, Error, what);
const count = (db: DatabaseSync, sql: string, ...a: Val[]): number => Number((db.prepare(sql).get(...a) as { n: number }).n);

test("version 14: a version 13 database gains the three empty tables and keeps its projects", () => {
  const db = openDatabase(":memory:");
  new AuditLog(db);
  runMigrations(db, "journal", JOURNAL_MIGRATIONS.slice(0, 13));
  db.prepare("INSERT INTO projects (id, path, display_name, trusted, created_at, updated_at) VALUES ('old', '/repo/old', 'Old', 0, ?, ?)").run(T, T);
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  assert.ok(JOURNAL_SCHEMA_VERSION >= 14);
  assert.equal(schemaVersion(db, "journal"), JOURNAL_SCHEMA_VERSION);
  for (const t of ["pages", "page_versions", "page_attachments"]) assert.equal(count(db, `SELECT count(*) AS n FROM ${t}`), 0, t);
  assert.deepEqual(journal.pages.list("old"), []);
  db.close();
});

test("every insert verb is refused for an existing id on every table, before any conflict clause", () => {
  const { db } = setup();
  insert(db, "pages", page());
  insert(db, "page_versions", ver());
  insert(db, "page_attachments", att());
  const verbs: [string, string][] = [["INSERT", ""], ["INSERT OR REPLACE", ""], ["REPLACE", ""], ["INSERT OR IGNORE", ""], ["INSERT", " ON CONFLICT DO NOTHING"]];
  for (const [verb, tail] of verbs) {
    refused(() => insert(db, "pages", page({ project_id: "p2" }), verb, tail), `pages ${verb}${tail}`);
    refused(() => insert(db, "page_versions", ver({ title: "Other" }), verb, tail), `page_versions ${verb}${tail}`);
    refused(() => insert(db, "page_attachments", att({ sha256: "b".repeat(64) }), verb, tail), `page_attachments ${verb}${tail}`);
  }
  refused(() => insert(db, "pages", page(), "INSERT", " ON CONFLICT (id) DO UPDATE SET project_id = 'p2'"), "pages upsert");
  refused(() => insert(db, "page_versions", ver(), "INSERT", " ON CONFLICT (page_id, seq) DO UPDATE SET body = 'x'"), "versions upsert");
  refused(() => insert(db, "page_attachments", att(), "INSERT", " ON CONFLICT (id) DO UPDATE SET created_by = 'user'"), "attachments upsert");
  assert.equal(count(db, "SELECT count(*) AS n FROM pages WHERE project_id = 'p1'"), 1);
  assert.equal((db.prepare("SELECT title FROM page_versions").get() as { title: string }).title, "Notes");
  assert.equal(count(db, "SELECT count(*) AS n FROM page_attachments WHERE sha256 = ?", "a".repeat(64)), 1);
  db.close();
});

test("a page: id format, a registered project, starts empty, keeps id, project and creation time; last_seq is its newest version", () => {
  const { db } = setup();
  for (const id of ["", "-a", "a b", "a/b", "a".repeat(65), "a\u0000b", "é"]) refused(() => insert(db, "pages", page({ id })), JSON.stringify(id));
  refused(() => insert(db, "pages", page({ project_id: "nope" })), "unregistered project");
  refused(() => insert(db, "pages", page({ last_seq: 1 })), "a page starts with no version");
  refused(() => insert(db, "pages", page({ created_at: "2026" })), "a short time");
  refused(() => insert(db, "pages", page({ created_at: "2026-11-22T00:00:00.000Z\u0000x" })), "a time with a NUL");
  insert(db, "pages", page({ id: "a".repeat(64) }));
  insert(db, "pages", page());
  for (const [col, v] of [["id", "pg2"], ["project_id", "p2"], ["created_at", "2026-11-23T00:00:00.000Z"]] as const) {
    refused(() => db.prepare(`UPDATE pages SET ${col} = ? WHERE id = 'pg1'`).run(v), col);
    refused(() => db.prepare(`UPDATE OR REPLACE pages SET ${col} = ? WHERE id = 'pg1'`).run(v), `${col} or replace`);
  }
  refused(() => db.prepare("UPDATE pages SET last_seq = 3 WHERE id = 'pg1'").run(), "last_seq must be the newest version");
  insert(db, "page_versions", ver());
  assert.equal(count(db, "SELECT last_seq AS n FROM pages WHERE id = 'pg1'"), 1, "a version advances last_seq");
  refused(() => db.prepare("UPDATE pages SET last_seq = 0 WHERE id = 'pg1'").run(), "last_seq never moves back");
  db.close();
});

test("a project holds at most 500 pages", () => {
  const { db } = setup();
  const stmt = db.prepare("INSERT INTO pages (id, project_id, last_seq, created_at, updated_at) VALUES (?, 'p1', 0, ?, ?)");
  for (let i = 0; i < PAGE_LIMITS.pagesPerProject; i++) stmt.run(`pg${i}`, T, T);
  refused(() => stmt.run("one-more", T, T), "the 501st page");
  insert(db, "pages", page({ id: "other", project_id: "p2" }));
  db.close();
});

test("a version: the next number, title and body rules, a closed author set, and no reviewed mark at insert", () => {
  const { db } = setup();
  insert(db, "pages", page());
  refused(() => insert(db, "page_versions", ver({ seq: 2 })), "a version skips a number");
  refused(() => insert(db, "page_versions", ver({ page_id: "nope" })), "no page");
  for (const title of ["", " a", "a ", "t".repeat(201), "a\u0000b", "a\u0001b", "a‮b", "a b", "a b"]) {
    refused(() => insert(db, "page_versions", ver({ title })), `title ${JSON.stringify(title)}`);
  }
  refused(() => insert(db, "page_versions", ver({ body: "a\u0000b" })), "a NUL in the body");
  refused(() => insert(db, "page_versions", ver({ body: "é".repeat(PAGE_LIMITS.bodyBytes / 2 + 1) })), "a body over 256 KiB of UTF-8");
  refused(() => insert(db, "page_versions", ver({ body: `${"é".repeat(PAGE_LIMITS.bodyBytes / 2)}x` })), "256 KiB + 1 byte");
  refused(() => insert(db, "page_versions", ver({ reviewed_at: T, author_kind: "agent", author_id: "w1", untrusted: 1 })), "reviewed at insert");
  for (const bad of [
    { author_kind: "admin" }, { author_kind: "user", author_id: "x" }, { author_kind: "system", author_id: "x", untrusted: 1 },
    { author_kind: "agent", author_id: null, untrusted: 1 }, { author_kind: "agent", author_id: "a/b", untrusted: 1 },
    { author_kind: "agent", author_id: "w1\u0000x", untrusted: 1 }, { author_kind: "agent", author_id: "w1", untrusted: 0 },
    { author_kind: "plugin", author_id: "Acme", untrusted: 1 }, { author_kind: "plugin", author_id: "acme..x", untrusted: 1 },
    { author_kind: "plugin", author_id: "acme.", untrusted: 1 }, { author_kind: "plugin", author_id: "acme.1x", untrusted: 1 },
    { author_kind: "plugin", author_id: "a".repeat(65), untrusted: 1 }, { author_kind: "system", untrusted: 0 },
    { author_kind: "agent", author_id: "w1", untrusted: 1, hop: 9 }, { author_kind: "agent", author_id: "w1", untrusted: 1, hop: -1 },
  ] as Row[]) refused(() => insert(db, "page_versions", ver(bad)), JSON.stringify(bad));
  insert(db, "page_versions", ver({ title: "t".repeat(200), body: "é".repeat(PAGE_LIMITS.bodyBytes / 2) }));
  insert(db, "page_versions", ver({ seq: 2, author_kind: "plugin", author_id: "acme.notes-2", untrusted: 1, hop: 8 }));
  insert(db, "page_versions", ver({ seq: 3, author_kind: "system", untrusted: 1, hop: 0 }));
  db.close();
});

test("a user edit inherits untrusted text and its hop until the user reviews it; it cannot claim to be trusted", () => {
  const { db } = setup();
  insert(db, "pages", page());
  refused(() => insert(db, "page_versions", ver({ untrusted: 1 })), "a first user version is trusted, not untrusted");
  insert(db, "page_versions", ver());
  insert(db, "page_versions", ver({ seq: 2, author_kind: "agent", author_id: "w1", untrusted: 1, hop: 3 }));
  refused(() => insert(db, "page_versions", ver({ seq: 3 })), "a user edit of agent text is not trusted");
  refused(() => insert(db, "page_versions", ver({ seq: 3, untrusted: 1, hop: 0 })), "nor does it drop the hop");
  refused(() => insert(db, "page_versions", ver({ seq: 3, untrusted: 1, hop: 4 })), "nor raise it");
  insert(db, "page_versions", ver({ seq: 3, untrusted: 1, hop: 3 }));
  db.prepare("UPDATE page_versions SET reviewed_at = ? WHERE seq = 3").run(T);
  refused(() => insert(db, "page_versions", ver({ seq: 4, untrusted: 1, hop: 3 })), "after review the next user edit is trusted");
  insert(db, "page_versions", ver({ seq: 4 }));
  db.close();
});

test("a restore copies its source, author and trust included, and records where it came from", () => {
  const { db } = setup();
  insert(db, "pages", page());
  insert(db, "page_versions", ver({ author_kind: "agent", author_id: "w1", untrusted: 1, hop: 2, body: "agent text" }));
  insert(db, "page_versions", ver({ seq: 2, untrusted: 1, hop: 2, body: "user edit" }));
  for (const bad of [
    { author_kind: "user", author_id: null, untrusted: 0, hop: 0 }, { author_id: "w2" }, { hop: 1 }, { body: "changed" }, { title: "Other" },
  ] as Row[]) {
    refused(() => insert(db, "page_versions", ver({ seq: 3, restored_from: 1, author_kind: "agent", author_id: "w1", untrusted: 1, hop: 2, body: "agent text", ...bad })), JSON.stringify(bad));
  }
  refused(() => insert(db, "page_versions", ver({ seq: 3, restored_from: 3, author_kind: "agent", author_id: "w1", untrusted: 1, hop: 2, body: "agent text" })), "from itself");
  // The source is a user edit of agent text (untrusted, hop 2): its copy cannot claim to be trusted at hop 0, nor keep the
  // untrusted flag and drop the hop, nor drop the flag and keep the hop.
  for (const bad of [{ untrusted: 0, hop: 0 }, { untrusted: 1, hop: 0 }, { untrusted: 0, hop: 2 }] as Row[]) {
    refused(() => insert(db, "page_versions", ver({ seq: 3, restored_from: 2, body: "user edit", ...bad })), `restore of an untrusted user edit as ${JSON.stringify(bad)}`);
  }
  // A hop-0 source (plugin text, then a user edit of it): only the untrusted flag tells the copy from a trusted version.
  insert(db, "pages", page({ id: "pg2" }));
  insert(db, "page_versions", ver({ page_id: "pg2", author_kind: "plugin", author_id: "acme.notes", untrusted: 1, hop: 0, body: "plugin text" }));
  insert(db, "page_versions", ver({ page_id: "pg2", seq: 2, untrusted: 1, hop: 0, body: "edited" }));
  refused(() => insert(db, "page_versions", ver({ page_id: "pg2", seq: 3, restored_from: 2, untrusted: 0, hop: 0, body: "edited" })), "a hop-0 untrusted edit restored as trusted");
  insert(db, "page_versions", ver({ seq: 3, restored_from: 1, author_kind: "agent", author_id: "w1", untrusted: 1, hop: 2, body: "agent text" }));
  db.close();
});

test("a version never changes; only an untrusted one is marked reviewed, once", () => {
  const { db } = setup();
  insert(db, "pages", page());
  insert(db, "page_versions", ver());
  insert(db, "page_versions", ver({ seq: 2, author_kind: "agent", author_id: "w1", untrusted: 1, hop: 1 }));
  for (const [col, v] of [
    ["page_id", "pg2"], ["seq", 9], ["title", "X"], ["body", "x"], ["author_kind", "user"], ["author_id", "w2"], ["hop", 0],
    ["untrusted", 0], ["restored_from", 1], ["created_at", "2026-11-23T00:00:00.000Z"],
  ] as const) {
    refused(() => db.prepare(`UPDATE page_versions SET ${col} = ? WHERE seq = 2`).run(v), col);
    refused(() => db.prepare(`UPDATE OR REPLACE page_versions SET ${col} = ? WHERE seq = 2`).run(v), `${col} or replace`);
  }
  refused(() => db.prepare("UPDATE page_versions SET reviewed_at = ? WHERE seq = 1").run(T), "a trusted version is not marked");
  db.prepare("UPDATE page_versions SET reviewed_at = ? WHERE seq = 2").run(T);
  refused(() => db.prepare("UPDATE page_versions SET reviewed_at = NULL WHERE seq = 2").run(), "a mark is never removed");
  refused(() => db.prepare("UPDATE page_versions SET reviewed_at = ? WHERE seq = 2").run("2026-11-23T00:00:00.000Z"), "or moved");
  refused(() => db.prepare("DELETE FROM page_versions WHERE seq = 1").run(), "a version is not deleted while its page exists");
  db.close();
});

test("the 101st version deletes the oldest in the same statement; no other version is deleted", () => {
  const { db } = setup();
  insert(db, "pages", page());
  for (let s = 1; s <= PAGE_LIMITS.versionsPerPage; s++) insert(db, "page_versions", ver({ seq: s, body: `v${s}` }));
  refused(() => db.prepare("DELETE FROM page_versions WHERE seq = 1").run(), "the oldest at the cap is kept");
  insert(db, "page_versions", ver({ seq: 101, body: "v101" }));
  assert.equal(count(db, "SELECT count(*) AS n FROM page_versions"), 100);
  assert.equal(count(db, "SELECT min(seq) AS n FROM page_versions"), 2);
  refused(() => db.prepare("DELETE FROM page_versions WHERE seq = 50").run(), "a middle version");
  db.close();
});

test("attachments: raster types checked against their bytes, 20 per page, 5 MiB, the user's, never changed", () => {
  const { db } = setup();
  insert(db, "pages", page());
  const jpeg = Buffer.from("ffd8ffe000104a4649460001", "hex");
  const gif = Buffer.from("474946383961010001000000", "hex");
  const webp = Buffer.from("524946460000000057454250", "hex");
  insert(db, "page_attachments", att());
  insert(db, "page_attachments", att({ id: "j", media_type: "image/jpeg", bytes: jpeg }));
  insert(db, "page_attachments", att({ id: "g", media_type: "image/gif", bytes: gif }));
  insert(db, "page_attachments", att({ id: "w", media_type: "image/webp", bytes: webp }));
  const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>");
  for (const bad of [
    { media_type: "image/svg+xml", bytes: svg }, { media_type: "image/png", bytes: svg }, { media_type: "image/png", bytes: jpeg },
    { media_type: "image/webp", bytes: Buffer.from("524946460000000041564920", "hex") }, { media_type: "text/html", bytes: PNG },
    { bytes: PNG.subarray(0, 8) }, { bytes: Buffer.concat([PNG, Buffer.alloc(PAGE_LIMITS.attachmentBytes)]) }, { created_by: "agent" },
    { sha256: "A".repeat(64) }, { sha256: "a".repeat(63) }, { page_id: "nope" },
  ] as Row[]) refused(() => insert(db, "page_attachments", att({ id: "x", ...bad })), JSON.stringify(Object.keys(bad)));
  refused(() => db.prepare("UPDATE page_attachments SET media_type = 'image/png' WHERE id = 'j'").run(), "never changed");
  insert(db, "page_attachments", att({ id: "max", bytes: Buffer.concat([PNG, Buffer.alloc(PAGE_LIMITS.attachmentBytes - PNG.length)]) }));
  refused(() => insert(db, "page_attachments", att({ id: "max1", bytes: Buffer.concat([PNG, Buffer.alloc(PAGE_LIMITS.attachmentBytes - PNG.length + 1)]) })), "5 MiB + 1");
  db.prepare("DELETE FROM page_attachments WHERE id = 'max'").run();
  for (let i = 4; i < PAGE_LIMITS.attachmentsPerPage; i++) insert(db, "page_attachments", att({ id: `a${i}` }));
  refused(() => insert(db, "page_attachments", att({ id: "a21" })), "the 21st attachment");
  db.close();
});

test("a project holds at most 200 MiB of version and attachment bytes, counted across its pages", () => {
  const { db } = setup();
  // 40 attachments fill the project to 400 bytes under its cap.
  const big = Buffer.concat([PNG, Buffer.alloc(PAGE_LIMITS.attachmentBytes - 10 - PNG.length)]);
  let n = 0;
  for (let p = 0; p < 3; p++) {
    insert(db, "pages", page({ id: `pg${p}` }));
    for (let i = 0; i < PAGE_LIMITS.attachmentsPerPage && n < 40; i++, n++) insert(db, "page_attachments", att({ id: `a${n}`, page_id: `pg${p}`, bytes: big }));
  }
  insert(db, "page_versions", ver({ page_id: "pg2", body: "x".repeat(100) })); // 105 bytes: 295 left
  refused(() => insert(db, "page_versions", ver({ page_id: "pg2", seq: 2, body: "x".repeat(291) })), "one byte past the project cap");
  insert(db, "page_versions", ver({ page_id: "pg2", seq: 2, body: "x".repeat(290) })); // exactly at the cap
  assert.equal(count(db, `SELECT ${projectBytesSql("?1")} AS n`, "p1"), PAGE_LIMITS.projectBytes);
  refused(() => insert(db, "page_versions", ver({ page_id: "pg2", seq: 3, title: "N", body: "" })), "any version at the cap");
  refused(() => insert(db, "page_attachments", att({ id: "over", page_id: "pg2", bytes: PNG.subarray(0, 12) })), "any attachment at the cap");
  insert(db, "pages", page({ id: "elsewhere", project_id: "p2" }));
  insert(db, "page_attachments", att({ id: "fine", page_id: "elsewhere", bytes: big }));
  db.close();
});

test("deleting a page deletes its versions and attachments in the same statement, and nothing else", () => {
  const { db } = setup();
  insert(db, "pages", page());
  insert(db, "pages", page({ id: "keep" }));
  insert(db, "page_versions", ver());
  insert(db, "page_versions", ver({ page_id: "keep" }));
  insert(db, "page_attachments", att());
  db.prepare("DELETE FROM pages WHERE id = 'pg1'").run();
  assert.equal(count(db, "SELECT count(*) AS n FROM page_versions WHERE page_id = 'pg1'"), 0);
  assert.equal(count(db, "SELECT count(*) AS n FROM page_attachments"), 0);
  assert.equal(count(db, "SELECT count(*) AS n FROM page_versions WHERE page_id = 'keep'"), 1);
  db.close();
});

test("stored byte counts: a version's bytes are its title and body, an attachment's size its bytes; neither changes", () => {
  const { db } = setup();
  insert(db, "pages", page());
  for (const bytes of [0, 8, 10, -1]) refused(() => insert(db, "page_versions", ver({ bytes })), `bytes ${bytes}`);
  insert(db, "page_versions", ver({ title: "é", body: "ü" }));
  assert.equal(count(db, "SELECT bytes AS n FROM page_versions"), 4, "UTF-8 bytes, not characters");
  refused(() => db.prepare("UPDATE page_versions SET bytes = 1").run(), "a count never changes");
  for (const size of [PNG.length - 1, PNG.length + 1, 0]) refused(() => insert(db, "page_attachments", att({ size })), `size ${size}`);
  insert(db, "page_attachments", att());
  db.close();
});

test("the project total is summed from the stored counts through covering indexes: no title, body or image is read", () => {
  const { db } = setup();
  const plan = (db.prepare(`EXPLAIN QUERY PLAN SELECT ${projectBytesSql("?1")} AS n`).all("p1") as { detail: string }[]).map((r) => r.detail);
  // The invariant, not the planner's wording: each count comes from its covering index, and neither table is scanned.
  assert.ok(plan.some((d) => d.includes("COVERING INDEX page_versions_bytes")), plan.join(" | "));
  assert.ok(plan.some((d) => d.includes("COVERING INDEX page_attachments_size")), plan.join(" | "));
  assert.ok(!plan.some((d) => /\bSCAN\b/.test(d) && /\b(v|a|page_versions|page_attachments)\b/.test(d)), plan.join(" | "));
  insert(db, "pages", page());
  insert(db, "page_versions", ver({ body: "x".repeat(1000) }));
  insert(db, "page_attachments", att());
  assert.equal(count(db, `SELECT ${projectBytesSql("?1")} AS n`, "p1"), 5 + 1000 + PNG.length);
  assert.equal(count(db, `SELECT ${projectBytesSql("?1")} AS n`, "p2"), 0);
  db.close();
});

test("a version is marked reviewed no earlier than it was written", () => {
  const { db } = setup();
  insert(db, "pages", page());
  insert(db, "page_versions", ver({ author_kind: "agent", author_id: "w1", untrusted: 1, hop: 1 }));
  refused(() => db.prepare("UPDATE page_versions SET reviewed_at = '2026-11-21T00:00:00.000Z'").run(), "before it was written");
  db.prepare("UPDATE page_versions SET reviewed_at = ?").run(T);
  db.close();
});
