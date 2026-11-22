// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash } from "node:crypto";
import { AxisError, withTransaction, type DatabaseSync } from "@axis/audit";
import { PAGE_LIMITS, projectBytesSql } from "./schema-pages.js";

/**
 * Pages, their versions and attachments (schema version 14, ticket PV-Q1 slice 1, ADR 0010). A data layer: the daemon's
 * pages service (a later slice) decides who may call what (restore, mark reviewed, delete and attachments are the user's
 * only), and writes the audit. This store derives every trust value itself and the table checks it again, so a caller can
 * never store a page as more trusted than it is.
 */
export type PageAuthor =
  | { readonly kind: "user" }
  | { readonly kind: "system"; readonly hop: number }
  | { readonly kind: "agent"; readonly agentId: string; readonly hop: number }
  | { readonly kind: "plugin"; readonly pluginId: string; readonly hop: number };

export interface PageVersionRecord {
  readonly pageId: string;
  readonly seq: number;
  readonly title: string;
  readonly body: string;
  readonly author: PageAuthor;
  /** The hop a reader of this version receives (0 for a trusted version). */
  readonly hop: number;
  /** May hold text the user did not write (IAC-T source 4) and is not reviewed. */
  readonly untrusted: boolean;
  readonly reviewedAt: string | null;
  readonly restoredFrom: number | null;
  readonly createdAt: string;
}
export type PageVersionMeta = Omit<PageVersionRecord, "body">;

export interface PageSummary {
  readonly pageId: string;
  readonly projectId: string;
  readonly lastSeq: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PageAttachmentRecord {
  readonly id: string;
  readonly pageId: string;
  readonly mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  readonly sha256: string;
  readonly size: number;
  readonly createdAt: string;
}

/** What a run reading the page's current version receives: whether it is a taint source and at which hop. */
export interface PageReadTaint {
  readonly seq: number;
  readonly untrusted: boolean;
  readonly hop: number;
}

type Row = Record<string, unknown>;
const refuse = (code: "E_NOT_FOUND" | "E_CONFLICT" | "E_INVALID_ARGUMENT", reason: string, message: string): never => {
  throw new AxisError(code, message, { reason });
};
const NOT_FOUND = (): never => refuse("E_NOT_FOUND", "not_found", "The page does not exist");
const bytesOf = (s: string): number => Buffer.byteLength(s, "utf8");
const VERSION_COLUMNS = "page_id, seq, title, author_kind, author_id, hop, untrusted, restored_from, reviewed_at, created_at";
const MEDIA_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function authorOf(r: Row): PageAuthor {
  const kind = r["author_kind"];
  const hop = Number(r["hop"]);
  if (kind === "user") return { kind: "user" };
  if (kind === "system") return { kind: "system", hop };
  if (kind === "agent") return { kind: "agent", agentId: String(r["author_id"]), hop };
  if (kind === "plugin") return { kind: "plugin", pluginId: String(r["author_id"]), hop };
  throw new AxisError("E_INTERNAL", "A stored page version has no known author");
}
function metaOf(r: Row): PageVersionMeta {
  return {
    pageId: String(r["page_id"]),
    seq: Number(r["seq"]),
    title: String(r["title"]),
    author: authorOf(r),
    hop: Number(r["hop"]),
    untrusted: r["untrusted"] === 1 && r["reviewed_at"] === null,
    reviewedAt: r["reviewed_at"] === null ? null : String(r["reviewed_at"]),
    restoredFrom: r["restored_from"] === null ? null : Number(r["restored_from"]),
    createdAt: String(r["created_at"]),
  };
}
function checkAuthor(a: PageAuthor): void {
  const ok =
    a !== null && typeof a === "object" &&
    (a.kind === "user" ||
      ((a.kind === "system" || a.kind === "agent" || a.kind === "plugin") && Number.isSafeInteger(a.hop) && a.hop >= 0 && a.hop <= 8 &&
        (a.kind !== "agent" || typeof a.agentId === "string") && (a.kind !== "plugin" || typeof a.pluginId === "string")));
  if (!ok) refuse("E_INVALID_ARGUMENT", "author", "A page version needs a known author");
}
function checkText(title: string, body: string): void {
  if (typeof title !== "string" || typeof body !== "string") refuse("E_INVALID_ARGUMENT", "text", "A page version needs a title and a body");
  if (bytesOf(body) > PAGE_LIMITS.bodyBytes || title.length > PAGE_LIMITS.titleChars) refuse("E_INVALID_ARGUMENT", "too_large", "The page is over its size limit");
}

export class PageRecords {
  readonly #db: DatabaseSync;
  readonly #ts: () => string;

  constructor(db: DatabaseSync, ts: () => string) {
    this.#db = db;
    this.#ts = ts;
  }

  /** A new page with its first version. `pageId` comes from the caller (the daemon's random id). */
  create(input: { readonly pageId: string; readonly projectId: string; readonly title: string; readonly body: string; readonly author: PageAuthor }): PageVersionRecord {
    checkAuthor(input.author);
    checkText(input.title, input.body);
    return withTransaction(this.#db, () => {
      if (this.#db.prepare("SELECT 1 FROM pages WHERE id = ?").get(input.pageId) !== undefined) refuse("E_CONFLICT", "exists", "A page with that id exists");
      const count = Number((this.#db.prepare("SELECT count(*) AS n FROM pages WHERE project_id = ?").get(input.projectId) as Row)["n"]);
      if (count >= PAGE_LIMITS.pagesPerProject) refuse("E_CONFLICT", "limit_reached", "The project holds its maximum of pages");
      this.#checkProjectBytes(input.projectId, bytesOf(input.title) + bytesOf(input.body));
      const at = this.#ts();
      this.#db.prepare("INSERT INTO pages (id, project_id, last_seq, created_at, updated_at) VALUES (?, ?, 0, ?, ?)").run(input.pageId, input.projectId, at, at);
      return this.#insert(input.pageId, 1, input.title, input.body, input.author, null, at);
    });
  }

  /** A new version on top of `baseSeq`; refused (`stale_version`) when another version came first. */
  update(input: { readonly pageId: string; readonly baseSeq: number; readonly title: string; readonly body: string; readonly author: PageAuthor }): PageVersionRecord {
    checkAuthor(input.author);
    checkText(input.title, input.body);
    return withTransaction(this.#db, () => {
      const page = this.#page(input.pageId);
      if (page.lastSeq !== input.baseSeq) refuse("E_CONFLICT", "stale_version", "The page changed since that version");
      this.#checkProjectBytes(page.projectId, bytesOf(input.title) + bytesOf(input.body));
      return this.#insert(input.pageId, page.lastSeq + 1, input.title, input.body, input.author, null, this.#ts());
    });
  }

  /** The user restores version `seq` as a new version: a copy of it, its author and trust included (never the user's). */
  restore(input: { readonly pageId: string; readonly seq: number; readonly baseSeq: number }): PageVersionRecord {
    return withTransaction(this.#db, () => {
      const page = this.#page(input.pageId);
      if (page.lastSeq !== input.baseSeq) refuse("E_CONFLICT", "stale_version", "The page changed since that version");
      const src = this.#db.prepare("SELECT title, body, bytes, author_kind, author_id, hop, untrusted FROM page_versions WHERE page_id = ? AND seq = ?").get(input.pageId, input.seq) as Row | undefined;
      if (src === undefined) return NOT_FOUND();
      this.#checkProjectBytes(page.projectId, Number(src["bytes"]));
      const seq = page.lastSeq + 1;
      const at = this.#ts();
      this.#db
        .prepare(`INSERT INTO page_versions (page_id, seq, title, body, bytes, author_kind, author_id, hop, untrusted, restored_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.pageId, seq, src["title"] as string, src["body"] as string, src["bytes"] as number, src["author_kind"] as string, src["author_id"] as string | null, src["hop"] as number, src["untrusted"] as number, input.seq, at);
      return this.get(input.pageId, seq) as PageVersionRecord;
    });
  }

  /** The user marks one untrusted version reviewed; false when it was trusted or already reviewed. */
  markReviewed(pageId: string, seq: number): boolean {
    return withTransaction(this.#db, () => {
      if (this.#db.prepare("SELECT 1 FROM page_versions WHERE page_id = ? AND seq = ?").get(pageId, seq) === undefined) return NOT_FOUND();
      const r = this.#db.prepare("UPDATE page_versions SET reviewed_at = ? WHERE page_id = ? AND seq = ? AND untrusted = 1 AND reviewed_at IS NULL").run(this.#ts(), pageId, seq);
      return Number(r.changes) === 1;
    });
  }

  /** Delete a page with its versions and attachments (the user's own act). */
  delete(pageId: string): void {
    withTransaction(this.#db, () => {
      this.#page(pageId);
      this.#db.prepare("DELETE FROM pages WHERE id = ?").run(pageId);
    });
  }

  /** A version (the newest when `seq` is omitted), or undefined. */
  get(pageId: string, seq?: number): PageVersionRecord | undefined {
    const r = (seq === undefined
      ? this.#db.prepare(`SELECT v.body, ${VERSION_COLUMNS.split(", ").map((c) => `v.${c}`).join(", ")} FROM page_versions v JOIN pages p ON p.id = v.page_id AND v.seq = p.last_seq WHERE p.id = ?`).get(pageId)
      : this.#db.prepare(`SELECT body, ${VERSION_COLUMNS} FROM page_versions WHERE page_id = ? AND seq = ?`).get(pageId, seq)) as Row | undefined;
    return r === undefined ? undefined : { ...metaOf(r), body: String(r["body"]) };
  }

  /** The page's versions, newest first, without bodies (at most 100). */
  versions(pageId: string): PageVersionMeta[] {
    this.#page(pageId);
    return (this.#db.prepare(`SELECT ${VERSION_COLUMNS} FROM page_versions WHERE page_id = ? ORDER BY seq DESC`).all(pageId) as Row[]).map(metaOf);
  }

  /** A project's pages, most recently changed first (at most 500). */
  list(projectId: string): PageSummary[] {
    const rows = this.#db.prepare("SELECT id, project_id, last_seq, created_at, updated_at FROM pages WHERE project_id = ? ORDER BY updated_at DESC, id").all(projectId) as Row[];
    return rows.map((r) => ({ pageId: String(r["id"]), projectId: String(r["project_id"]), lastSeq: Number(r["last_seq"]), createdAt: String(r["created_at"]), updatedAt: String(r["updated_at"]) }));
  }

  /** What a run reading the current version receives (the taint producer of a later slice uses this). */
  readTaint(pageId: string): PageReadTaint {
    const v = this.get(pageId);
    if (v === undefined) return NOT_FOUND();
    return { seq: v.seq, untrusted: v.untrusted, hop: v.untrusted ? v.hop : 0 };
  }

  /** The user adds a raster image; its type is checked against its leading bytes by the table. */
  addAttachment(input: { readonly id: string; readonly pageId: string; readonly mediaType: string; readonly bytes: Uint8Array }): PageAttachmentRecord {
    if (!MEDIA_TYPES.has(input.mediaType) || !(input.bytes instanceof Uint8Array)) refuse("E_INVALID_ARGUMENT", "media_type", "Only PNG, JPEG, GIF and WebP images are attachments");
    if (input.bytes.length > PAGE_LIMITS.attachmentBytes) refuse("E_INVALID_ARGUMENT", "too_large", "The attachment is over its size limit");
    return withTransaction(this.#db, () => {
      const page = this.#page(input.pageId);
      const n = Number((this.#db.prepare("SELECT count(*) AS n FROM page_attachments WHERE page_id = ?").get(input.pageId) as Row)["n"]);
      if (n >= PAGE_LIMITS.attachmentsPerPage) refuse("E_CONFLICT", "limit_reached", "The page holds its maximum of attachments");
      this.#checkProjectBytes(page.projectId, input.bytes.length);
      const sha256 = createHash("sha256").update(input.bytes).digest("hex");
      const at = this.#ts();
      this.#db
        .prepare("INSERT INTO page_attachments (id, page_id, media_type, bytes, size, sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'user', ?)")
        .run(input.id, input.pageId, input.mediaType, input.bytes, input.bytes.length, sha256, at);
      return { id: input.id, pageId: input.pageId, mediaType: input.mediaType as PageAttachmentRecord["mediaType"], sha256, size: input.bytes.length, createdAt: at };
    });
  }

  /** The user removes an attachment; false when it did not exist. */
  removeAttachment(id: string): boolean {
    return Number(this.#db.prepare("DELETE FROM page_attachments WHERE id = ?").run(id).changes) === 1;
  }

  /** A page's attachments, oldest first, without their bytes. */
  attachments(pageId: string): PageAttachmentRecord[] {
    const rows = this.#db.prepare("SELECT id, page_id, media_type, sha256, size, created_at FROM page_attachments WHERE page_id = ? ORDER BY created_at, id").all(pageId) as Row[];
    return rows.map((r) => ({ id: String(r["id"]), pageId: String(r["page_id"]), mediaType: r["media_type"] as PageAttachmentRecord["mediaType"], sha256: String(r["sha256"]), size: Number(r["size"]), createdAt: String(r["created_at"]) }));
  }

  /** An attachment's bytes, or undefined. */
  attachmentBytes(id: string): Uint8Array | undefined {
    const r = this.#db.prepare("SELECT bytes FROM page_attachments WHERE id = ?").get(id) as Row | undefined;
    return r === undefined ? undefined : new Uint8Array(r["bytes"] as Uint8Array);
  }

  #page(pageId: string): { projectId: string; lastSeq: number } {
    const r = this.#db.prepare("SELECT project_id, last_seq FROM pages WHERE id = ?").get(pageId) as Row | undefined;
    return r === undefined ? NOT_FOUND() : { projectId: String(r["project_id"]), lastSeq: Number(r["last_seq"]) };
  }

  #checkProjectBytes(projectId: string, adding: number): void {
    const used = Number((this.#db.prepare(`SELECT ${projectBytesSql("?1")} AS n`).get(projectId) as Row)["n"]);
    if (used + adding > PAGE_LIMITS.projectBytes) refuse("E_CONFLICT", "limit_reached", "The project holds its maximum of page bytes");
  }

  /** A new edit (not a restore): the trust values are derived here and checked again by the table. */
  #insert(pageId: string, seq: number, title: string, body: string, author: PageAuthor, restoredFrom: number | null, at: string): PageVersionRecord {
    let untrusted = 1;
    let hop = author.kind === "user" ? 0 : author.hop;
    if (author.kind === "user") {
      const prev = this.#db.prepare("SELECT untrusted, reviewed_at, hop FROM page_versions WHERE page_id = ? AND seq = ?").get(pageId, seq - 1) as Row | undefined;
      const inherits = prev !== undefined && prev["untrusted"] === 1 && prev["reviewed_at"] === null;
      untrusted = inherits ? 1 : 0;
      hop = inherits ? Number(prev["hop"]) : 0;
    }
    const authorId = author.kind === "agent" ? author.agentId : author.kind === "plugin" ? author.pluginId : null;
    this.#db
      .prepare(`INSERT INTO page_versions (page_id, seq, title, body, bytes, author_kind, author_id, hop, untrusted, restored_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(pageId, seq, title, body, bytesOf(title) + bytesOf(body), author.kind, authorId, hop, untrusted, restoredFrom, at);
    return this.get(pageId, seq) as PageVersionRecord;
  }
}
