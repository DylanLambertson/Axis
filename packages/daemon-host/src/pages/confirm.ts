// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { createHash } from "node:crypto";
import type { ApprovalContentHook } from "@axis/daemon";
import type { Journal } from "@axis/journal";

/**
 * The approval content of the tier-4 pages methods (`markReviewed`, `delete`; threat model 2a O-4): what main's native
 * dialog says the confirmation is for, and what the approval is bound to.
 *
 * - **Target** `page:<pageId>`; **content digest** over the page's id, project, newest version number and, for
 *   `markReviewed`, the version's number, byte length and author kind. A page that changes between the dialog and the
 *   action (a new version, a delete) no longer matches, and the approval is refused (`E_CONFLICT`).
 * - **The dialog line** is built only from values the daemon derives: the project's display name (which the user chose),
 *   the page id, version numbers, a byte length and the author's kind, in that order (the dialog cuts the line at 80 units,
 *   so the project name, last, is what a long line loses). Never the page's title or body: a worker may have
 *   written them, and they could say "safe to confirm" (`gate/summary.ts`). The renderer's card shows the title; the
 *   dialog's ids and numbers let the user match it.
 * - **No lock.** Page writes are synchronous single statements; the digest is computed when the challenge is issued and
 *   again just before the action runs, so a change in between fails the approval.
 */
export interface PagesConfirmDeps {
  readonly journal: Pick<Journal, "pages" | "getProject">;
  /** Records the dialog line for (target, content digest): `createWorktreesApprovals().onPreview`. */
  readonly onPreview: (target: string, contentDigest: string, text: string) => void;
}

const MISSING = "0".repeat(64);
const AUTHOR: Record<string, string> = { user: "the user", agent: "a worker", plugin: "a plugin", system: "Axis" };

function pageIdOf(payload: unknown): string {
  const id = typeof payload === "object" && payload !== null ? (payload as { pageId?: unknown }).pageId : undefined;
  return typeof id === "string" ? id : "";
}

/** The digest and the dialog line of one call, or a digest of nothing for a page that does not exist (the handler refuses). */
export function pageContent(journal: PagesConfirmDeps["journal"], method: "markReviewed" | "delete", payload: unknown): { readonly digest: string; readonly text: string | undefined } {
  const pageId = pageIdOf(payload);
  const projectId = journal.pages.projectOf(pageId);
  const newest = projectId === undefined ? undefined : journal.pages.get(pageId);
  if (projectId === undefined || newest === undefined) return { digest: MISSING, text: undefined };
  const project = journal.getProject(projectId)?.displayName ?? projectId;
  const parts: (string | number)[] = [method, pageId, projectId, newest.seq];
  let text: string;
  if (method === "markReviewed") {
    const seq = (payload as { seq?: unknown }).seq;
    const v = typeof seq === "number" ? journal.pages.get(pageId, seq) : undefined;
    if (v === undefined) return { digest: MISSING, text: undefined };
    const bytes = Buffer.byteLength(v.title, "utf8") + Buffer.byteLength(v.body, "utf8");
    parts.push(v.seq, bytes, v.author.kind);
    text = `page ${pageId} v${v.seq}/${newest.seq}, ${bytes} bytes by ${AUTHOR[v.author.kind] ?? "another writer"}, in ${project}`;
  } else {
    text = `page ${pageId}, all ${newest.seq} versions, in ${project}`;
  }
  return { digest: createHash("sha256").update(JSON.stringify(parts)).digest("hex"), text };
}

export function createPagesContentHooks(deps: PagesConfirmDeps): { readonly markReviewed: ApprovalContentHook; readonly delete: ApprovalContentHook } {
  const hook = (method: "markReviewed" | "delete"): ApprovalContentHook => (_ctx, payload) => {
    const target = `page:${pageIdOf(payload) || "unknown"}`;
    return {
      target,
      withLock: async (fn) => {
        const { digest, text } = pageContent(deps.journal, method, payload);
        if (text !== undefined) deps.onPreview(target, digest, text);
        return fn(digest);
      },
    };
  };
  return { markReviewed: hook("markReviewed"), delete: hook("delete") };
}
