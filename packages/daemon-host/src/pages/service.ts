// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError, type AuditEventInput } from "@axis/audit";
import type { Journal, PageAuthor, PageVersionMeta, PageVersionRecord } from "@axis/journal";
import { isPagesRefusal, type PagesRefusalCode, type PagesRequest, type PagesResponse } from "@axis/protocol";

/**
 * The pages service (ticket PV-Q1 slice 2, ADR 0010, docs/design/pages-store.md §5) over `Journal.pages`. It serves two
 * callers, each attested by its binding and never taken from a payload: the user's bridge connection (`axis.pages/1`, every
 * method) and a composer run of a worker (`read_page`, `write_page`, scoped to the worker's project).
 *
 * - **The author is the caller.** The user writes as `user`; a run writes as its worker, at the run's received hop. The
 *   store derives `untrusted` and the hop from it, and the table checks them again.
 * - **Every write and its audit row are one transaction.** A row holds ids, the sequence number, the caller's and author's
 *   kinds and a byte length: never a title or a body. No keyed hash of a body is written until the per-install key exists
 *   (threat-model-phase2a O-1).
 * - **Refusals are closed.** A store refusal with a reason of the contract's set leaves as that reason; anything else (a
 *   store reason the contract does not have, a database error) is `E_INTERNAL` at the handler, with no text of its own.
 */
export type PageCaller =
  | { readonly kind: "user" }
  | { readonly kind: "agent"; readonly agentId: string; readonly projectId: string; readonly runId: string; readonly receivedHop: number };

export class PagesRefusal extends Error {
  constructor(readonly code: PagesRefusalCode, readonly reason: string) {
    super(reason);
  }
}
const NOT_FOUND = (): never => {
  throw new PagesRefusal("E_NOT_FOUND", "not_found");
};

export const PAGE_AUDIT = { create: "page.create", update: "page.update", restore: "page.restore", review: "page.review", delete: "page.delete" } as const;
const PAYLOAD = ["pageId", "projectId", "seq", "bytes", "authorKind", "callerKind", "runId", "changed"] as const;
export const PAGES_PAYLOAD_ALLOWLIST: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(Object.values(PAGE_AUDIT).map((a) => [a, Object.freeze([...PAYLOAD])])),
);

export interface PagesServiceDeps {
  readonly journal: Pick<Journal, "pages" | "getProject">;
  readonly audit: { append(input: AuditEventInput): unknown };
  readonly noteWrite?: () => void;
  readonly random: { bytes(n: number): Uint8Array };
}

type Author = { kind: "user" } | { kind: "agent"; agentId: string } | { kind: "plugin"; pluginId: string } | { kind: "system" };
export function authorWire(a: PageAuthor): Author {
  return a.kind === "agent" ? { kind: "agent", agentId: a.agentId } : a.kind === "plugin" ? { kind: "plugin", pluginId: a.pluginId } : { kind: a.kind };
}
export function metaWire(m: PageVersionMeta) {
  return { pageId: m.pageId, seq: m.seq, title: m.title, author: authorWire(m.author), hop: m.hop, untrusted: m.untrusted, reviewed: m.reviewedAt !== null, restoredFrom: m.restoredFrom, createdAt: m.createdAt };
}
const versionWire = (v: PageVersionRecord) => ({ meta: metaWire(v), body: v.body });

/** A store refusal of the contract's closed set as a `PagesRefusal`; anything else is rethrown (E_INTERNAL at the edge). */
function closed(e: unknown): never {
  if (e instanceof AxisError) {
    const reason = (e.detail as { reason?: unknown }).reason;
    if (typeof reason === "string" && isPagesRefusal(e.code, reason)) throw new PagesRefusal(e.code as PagesRefusalCode, reason);
  }
  throw e;
}

export interface PagesService {
  list(req: PagesRequest<"list">): PagesResponse<"list">;
  get(req: PagesRequest<"get">): PagesResponse<"get">;
  versions(req: PagesRequest<"versions">): PagesResponse<"versions">;
  create(caller: PageCaller, req: PagesRequest<"create">): PagesResponse<"create">;
  update(caller: PageCaller, req: PagesRequest<"update">): PagesResponse<"update">;
  restore(req: PagesRequest<"restore">): PagesResponse<"restore">;
  markReviewed(req: PagesRequest<"markReviewed">): PagesResponse<"markReviewed">;
  delete(req: PagesRequest<"delete">): PagesResponse<"delete">;
  /** A version as a run may read it: only a page of its worker's project, else `not_found`. */
  readForRun(caller: Extract<PageCaller, { kind: "agent" }>, pageId: string, seq?: number): PageVersionRecord;
  /** The project of a page, or undefined. */
  projectOf(pageId: string): string | undefined;
}

export function createPagesService(deps: PagesServiceDeps): PagesService {
  const store = deps.journal.pages;
  const audit = (caller: PageCaller, action: string, v: { pageId: string; seq: number; bytes?: number; author?: PageAuthor; changed?: boolean }, projectId: string): void => {
    deps.audit.append({
      actor: caller.kind === "user" ? "user" : `agent:${caller.agentId}`,
      action,
      target: `page:${v.pageId}`,
      outcome: "success",
      payload: {
        pageId: v.pageId, projectId, seq: v.seq, callerKind: caller.kind,
        ...(v.bytes === undefined ? {} : { bytes: v.bytes }), ...(v.author === undefined ? {} : { authorKind: v.author.kind }),
        ...(caller.kind === "agent" ? { runId: caller.runId } : {}), ...(v.changed === undefined ? {} : { changed: v.changed }),
      },
    });
    deps.noteWrite?.();
  };
  const bytes = (v: { title: string; body: string }): number => Buffer.byteLength(v.title, "utf8") + Buffer.byteLength(v.body, "utf8");
  const authorOf = (c: PageCaller): PageAuthor => (c.kind === "user" ? { kind: "user" } : { kind: "agent", agentId: c.agentId, hop: c.receivedHop });
  const id = (): string => `p${Buffer.from(deps.random.bytes(16)).toString("hex")}`;
  const scoped = (caller: PageCaller, pageId: string): string => {
    const projectId = store.projectOf(pageId);
    if (projectId === undefined || (caller.kind === "agent" && projectId !== caller.projectId)) return NOT_FOUND();
    return projectId;
  };
  return {
    list: (req) => {
      if (deps.journal.getProject(req.projectId) === undefined) return NOT_FOUND();
      return {
        pages: store.list(req.projectId).map((p) => {
          const current = store.versions(p.pageId)[0];
          if (current === undefined) throw new AxisError("E_INTERNAL", "A page has no version");
          return { pageId: p.pageId, projectId: p.projectId, current: metaWire(current), createdAt: p.createdAt, updatedAt: p.updatedAt };
        }),
      };
    },
    get: (req) => {
      const v = store.get(req.pageId, req.seq);
      return v === undefined ? NOT_FOUND() : { version: versionWire(v) };
    },
    versions: (req) => {
      try {
        return { versions: store.versions(req.pageId).map(metaWire) };
      } catch (e) {
        return closed(e);
      }
    },
    create: (caller, req) => {
      if (deps.journal.getProject(req.projectId) === undefined || (caller.kind === "agent" && caller.projectId !== req.projectId)) return NOT_FOUND();
      try {
        return store.transaction(() => {
          const v = store.create({ pageId: id(), projectId: req.projectId, title: req.title, body: req.body, author: authorOf(caller) });
          audit(caller, PAGE_AUDIT.create, { pageId: v.pageId, seq: v.seq, bytes: bytes(v), author: v.author }, req.projectId);
          return { version: versionWire(v) };
        });
      } catch (e) {
        return closed(e);
      }
    },
    update: (caller, req) => {
      const projectId = scoped(caller, req.pageId);
      try {
        return store.transaction(() => {
          const v = store.update({ pageId: req.pageId, baseSeq: req.baseSeq, title: req.title, body: req.body, author: authorOf(caller) });
          audit(caller, PAGE_AUDIT.update, { pageId: v.pageId, seq: v.seq, bytes: bytes(v), author: v.author }, projectId);
          return { version: versionWire(v) };
        });
      } catch (e) {
        return closed(e);
      }
    },
    restore: (req) => {
      const projectId = scoped({ kind: "user" }, req.pageId);
      try {
        return store.transaction(() => {
          const v = store.restore({ pageId: req.pageId, seq: req.seq, baseSeq: req.baseSeq });
          audit({ kind: "user" }, PAGE_AUDIT.restore, { pageId: v.pageId, seq: v.seq, bytes: bytes(v), author: v.author }, projectId);
          return { version: versionWire(v) };
        });
      } catch (e) {
        return closed(e);
      }
    },
    markReviewed: (req) => {
      const projectId = scoped({ kind: "user" }, req.pageId);
      try {
        return store.transaction(() => {
          const changed = store.markReviewed(req.pageId, req.seq);
          const v = store.get(req.pageId, req.seq);
          if (v === undefined) return NOT_FOUND();
          audit({ kind: "user" }, PAGE_AUDIT.review, { pageId: v.pageId, seq: v.seq, author: v.author, changed }, projectId);
          return { version: metaWire(v), changed };
        });
      } catch (e) {
        return closed(e);
      }
    },
    delete: (req) => {
      const projectId = scoped({ kind: "user" }, req.pageId);
      try {
        return store.transaction(() => {
          const last = store.get(req.pageId);
          store.delete(req.pageId);
          audit({ kind: "user" }, PAGE_AUDIT.delete, { pageId: req.pageId, seq: last?.seq ?? 0 }, projectId);
          return { deleted: true as const };
        });
      } catch (e) {
        return closed(e);
      }
    },
    readForRun: (caller, pageId, seq) => {
      scoped(caller, pageId);
      const v = store.get(pageId, seq);
      return v === undefined ? NOT_FOUND() : v;
    },
    projectOf: (pageId) => store.projectOf(pageId),
  };
}
