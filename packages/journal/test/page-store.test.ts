// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { AuditLog, openDatabase, type DatabaseSync } from "@axis/audit";
import { Journal, PAGE_LIMITS, type PageAuthor } from "../src/index.js";

// The pages store (ticket PV-Q1 slice 1, ADR 0010): Journal.pages derives every trust value itself, so no caller can store
// a page as more trusted than it is; refusals carry a closed reason. The table rules are migration-v14.test.ts.

const T = "2026-11-22T00:00:00.000Z";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const USER: PageAuthor = { kind: "user" };
const AGENT: PageAuthor = { kind: "agent", agentId: "w1", hop: 3 };

function setup(): { db: DatabaseSync; journal: Journal } {
  let tick = 0;
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db), now: () => new Date(Date.parse(T) + 1000 * tick++) });
  journal.registerProject({ id: "p1", path: "/repo/one", displayName: "One", trusted: false, actor: "user" });
  journal.registerProject({ id: "p2", path: "/repo/two", displayName: "Two", trusted: false, actor: "user" });
  return { db, journal };
}
const reason = (f: () => unknown, code: string, why: string): void =>
  assert.throws(f, (e: unknown) => (e as { code?: string }).code === code && (e as { detail?: { reason?: string } }).detail?.reason === why, `${code} ${why}`);

test("create, update and get: versions count up, the newest is current, and a user page is trusted", () => {
  const { journal } = setup();
  const v1 = journal.pages.create({ pageId: "pg1", projectId: "p1", title: "Notes", body: "# One", author: USER });
  assert.deepEqual([v1.seq, v1.untrusted, v1.hop, v1.author, v1.restoredFrom, v1.reviewedAt], [1, false, 0, USER, null, null]);
  const v2 = journal.pages.update({ pageId: "pg1", baseSeq: 1, title: "Notes", body: "# Two", author: USER });
  assert.equal(v2.seq, 2);
  assert.equal(journal.pages.get("pg1")?.body, "# Two");
  assert.equal(journal.pages.get("pg1", 1)?.body, "# One");
  assert.equal(journal.pages.get("pg1", 9), undefined);
  assert.equal(journal.pages.get("nope"), undefined);
  assert.deepEqual(journal.pages.versions("pg1").map((v) => v.seq), [2, 1]);
  assert.equal("body" in (journal.pages.versions("pg1")[0] as object), false, "version lists carry no body");
  assert.deepEqual(journal.pages.list("p1").map((p) => [p.pageId, p.lastSeq]), [["pg1", 2]]);
  assert.deepEqual(journal.pages.list("p2"), []);
  assert.deepEqual(journal.pages.readTaint("pg1"), { seq: 2, untrusted: false, hop: 0 });
});

test("an agent's text taints a reader until the user reviews it; a later user edit keeps it until then", () => {
  const { journal } = setup();
  journal.pages.create({ pageId: "pg1", projectId: "p1", title: "Plan", body: "user text", author: USER });
  journal.pages.update({ pageId: "pg1", baseSeq: 1, title: "Plan", body: "agent text", author: AGENT });
  assert.deepEqual(journal.pages.readTaint("pg1"), { seq: 2, untrusted: true, hop: 3 });
  const v3 = journal.pages.update({ pageId: "pg1", baseSeq: 2, title: "Plan", body: "agent text, edited", author: USER });
  assert.deepEqual([v3.untrusted, v3.hop, v3.author], [true, 3, USER], "a user edit elsewhere does not clear it");
  assert.equal(journal.pages.markReviewed("pg1", 3), true);
  assert.equal(journal.pages.markReviewed("pg1", 3), false, "a mark is set once");
  assert.equal(journal.pages.markReviewed("pg1", 1), false, "a trusted version needs none");
  assert.deepEqual(journal.pages.readTaint("pg1"), { seq: 3, untrusted: false, hop: 0 });
  const v4 = journal.pages.update({ pageId: "pg1", baseSeq: 3, title: "Plan", body: "clean", author: USER });
  assert.deepEqual([v4.untrusted, v4.hop], [false, 0]);
  journal.pages.update({ pageId: "pg1", baseSeq: 4, title: "Plan", body: "plugin", author: { kind: "plugin", pluginId: "acme.notes", hop: 0 } });
  assert.deepEqual(journal.pages.readTaint("pg1"), { seq: 5, untrusted: true, hop: 0 }, "any non-user revision taints, hop 0 included");
  reason(() => journal.pages.markReviewed("pg1", 99), "E_NOT_FOUND", "not_found");
});

test("a restore copies the source's author and trust; restoring agent text never makes it the user's", () => {
  const { journal } = setup();
  journal.pages.create({ pageId: "pg1", projectId: "p1", title: "Plan", body: "agent text", author: AGENT });
  journal.pages.markReviewed("pg1", 1);
  journal.pages.update({ pageId: "pg1", baseSeq: 1, title: "Plan", body: "mine", author: USER });
  const r = journal.pages.restore({ pageId: "pg1", seq: 1, baseSeq: 2 });
  assert.deepEqual([r.seq, r.body, r.author, r.hop, r.untrusted, r.restoredFrom, r.reviewedAt], [3, "agent text", AGENT, 3, true, 1, null]);
  reason(() => journal.pages.restore({ pageId: "pg1", seq: 9, baseSeq: 3 }), "E_NOT_FOUND", "not_found");
  reason(() => journal.pages.restore({ pageId: "pg1", seq: 1, baseSeq: 2 }), "E_CONFLICT", "stale_version");
});

test("a write on top of an old version is refused as stale; closed reasons for every refusal", () => {
  const { journal } = setup();
  journal.pages.create({ pageId: "pg1", projectId: "p1", title: "A", body: "1", author: USER });
  reason(() => journal.pages.update({ pageId: "pg1", baseSeq: 0, title: "A", body: "2", author: USER }), "E_CONFLICT", "stale_version");
  reason(() => journal.pages.update({ pageId: "nope", baseSeq: 1, title: "A", body: "2", author: USER }), "E_NOT_FOUND", "not_found");
  reason(() => journal.pages.create({ pageId: "pg1", projectId: "p1", title: "A", body: "1", author: USER }), "E_CONFLICT", "exists");
  reason(() => journal.pages.create({ pageId: "pg2", projectId: "p1", title: "A", body: "é".repeat(PAGE_LIMITS.bodyBytes / 2 + 1), author: USER }), "E_INVALID_ARGUMENT", "too_large");
  reason(() => journal.pages.create({ pageId: "pg2", projectId: "p1", title: "t".repeat(201), body: "x", author: USER }), "E_INVALID_ARGUMENT", "too_large");
  for (const author of [{ kind: "admin" }, { kind: "agent", agentId: "w1", hop: 9 }, { kind: "agent", hop: 1 }, { kind: "plugin", pluginId: "p", hop: 1.5 }, null]) {
    reason(() => journal.pages.create({ pageId: "pg2", projectId: "p1", title: "A", body: "x", author: author as unknown as PageAuthor }), "E_INVALID_ARGUMENT", "author");
  }
  assert.throws(() => journal.pages.create({ pageId: "pg2", projectId: "p1", title: " A", body: "x", author: USER }), "the table refuses what the store does not check");
  assert.equal(journal.pages.get("pg2"), undefined, "nothing of a refused create is kept");
  assert.deepEqual(journal.pages.list("p1").map((p) => p.pageId), ["pg1"]);
});

test("limits: pages per project, attachments per page, project bytes", () => {
  const { db, journal } = setup();
  const stmt = db.prepare("INSERT INTO pages (id, project_id, last_seq, created_at, updated_at) VALUES (?, 'p1', 0, ?, ?)");
  for (let i = 0; i < PAGE_LIMITS.pagesPerProject; i++) stmt.run(`pg${i}`, T, T);
  reason(() => journal.pages.create({ pageId: "x", projectId: "p1", title: "A", body: "1", author: USER }), "E_CONFLICT", "limit_reached");
  journal.pages.create({ pageId: "q", projectId: "p2", title: "A", body: "1", author: USER });
  for (let i = 0; i < PAGE_LIMITS.attachmentsPerPage; i++) journal.pages.addAttachment({ id: `a${i}`, pageId: "q", mediaType: "image/png", bytes: PNG });
  reason(() => journal.pages.addAttachment({ id: "a20", pageId: "q", mediaType: "image/png", bytes: PNG }), "E_CONFLICT", "limit_reached");
  db.prepare("DELETE FROM page_attachments").run();
  const big = new Uint8Array(Buffer.concat([PNG, Buffer.alloc(PAGE_LIMITS.attachmentBytes - PNG.length)]));
  journal.pages.create({ pageId: "q2", projectId: "p2", title: "B", body: "1", author: USER });
  for (let i = 0; i < 39; i++) journal.pages.addAttachment({ id: `b${i}`, pageId: i < 20 ? "q" : "q2", mediaType: "image/png", bytes: big });
  reason(() => journal.pages.addAttachment({ id: "b39", pageId: "q2", mediaType: "image/png", bytes: big }), "E_CONFLICT", "limit_reached");
});

test("attachments: the user's raster images with a computed hash; listed without bytes; removed one at a time", () => {
  const { journal } = setup();
  journal.pages.create({ pageId: "pg1", projectId: "p1", title: "A", body: "1", author: USER });
  const a = journal.pages.addAttachment({ id: "a1", pageId: "pg1", mediaType: "image/png", bytes: PNG });
  assert.equal(a.sha256, createHash("sha256").update(PNG).digest("hex"));
  assert.deepEqual(journal.pages.attachments("pg1").map((x) => [x.id, x.size, x.mediaType]), [["a1", PNG.length, "image/png"]]);
  assert.deepEqual(Buffer.from(journal.pages.attachmentBytes("a1") ?? []), PNG);
  reason(() => journal.pages.addAttachment({ id: "a2", pageId: "pg1", mediaType: "image/svg+xml", bytes: PNG }), "E_INVALID_ARGUMENT", "media_type");
  assert.throws(() => journal.pages.addAttachment({ id: "a2", pageId: "pg1", mediaType: "image/jpeg", bytes: PNG }), "a type the bytes do not match");
  reason(() => journal.pages.addAttachment({ id: "a2", pageId: "nope", mediaType: "image/png", bytes: PNG }), "E_NOT_FOUND", "not_found");
  assert.equal(journal.pages.removeAttachment("a1"), true);
  assert.equal(journal.pages.removeAttachment("a1"), false);
  assert.equal(journal.pages.attachmentBytes("a1"), undefined);
});

test("delete removes the page, its versions and attachments; other pages stay", () => {
  const { db, journal } = setup();
  journal.pages.create({ pageId: "pg1", projectId: "p1", title: "A", body: "1", author: USER });
  journal.pages.create({ pageId: "pg2", projectId: "p1", title: "B", body: "1", author: AGENT });
  journal.pages.addAttachment({ id: "a1", pageId: "pg1", mediaType: "image/png", bytes: PNG });
  journal.pages.delete("pg1");
  assert.equal(journal.pages.get("pg1"), undefined);
  assert.deepEqual(journal.pages.list("p1").map((p) => p.pageId), ["pg2"]);
  assert.equal(Number((db.prepare("SELECT count(*) AS n FROM page_attachments").get() as { n: number }).n), 0);
  reason(() => journal.pages.delete("pg1"), "E_NOT_FOUND", "not_found");
  reason(() => journal.pages.versions("pg1"), "E_NOT_FOUND", "not_found");
  reason(() => journal.pages.readTaint("pg1"), "E_NOT_FOUND", "not_found");
});
