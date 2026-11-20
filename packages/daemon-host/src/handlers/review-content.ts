// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { Handler, HandlerContext } from "@axis/daemon";
import {
  MAX_CONTENT_FILE_CHARS,
  MAX_CONTENT_RESPONSE_CHARS,
  MAX_REVIEW_PATH,
  reviewContentRequestSchema,
  reviewContentResponseSchema,
  toDisplayPath,
  viewChars,
  type ContentView,
  type ReviewContentFile,
} from "@axis/protocol";
import type { PortContext } from "../ports/common.js";
import type { ReviewRound, ReviewService, RoundFile } from "../ports/review.js";
import { fail, mapRefusal, NOT_AVAILABLE } from "./review-errors.js";
import { fileView, linkView } from "./review-content-view.js";
import { contentIdOf, fileIdOf, foldEqualPaths, hasReplacementChar, isProtected, protectedFirst } from "./review-wire.js";

/**
 * `axis.review/1.content` (read, tier 1, user only; docs/design/review-core.md section 6b): the bounded, escaped view of what
 * each named file would commit. The worktree is read once into the snapshot tree, exactly as `diff` reads it; every view is
 * read from that tree's entry in the object store (never from the work tree, so a file swapped for a symlink after the
 * snapshot is not followed), and carries the `contentId` `diff` computes for that same entry. Nothing is accepted, built,
 * recorded or audited: showing content is a read, and the acknowledgement still happens in `diff`.
 */
export function createReviewContentHandler(deps: { readonly review: ReviewService }): Handler {
  return async (context: HandlerContext, payload: never) => {
    if (context.signal.aborted) return fail("E_CANCELLED", "The request was cancelled.");
    const { identity } = context;
    if (identity.actor !== "user") return fail("E_NOT_FOUND", NOT_AVAILABLE);
    const request = reviewContentRequestSchema.safeParse(payload);
    if (!request.success) return fail("E_INVALID_ARGUMENT", "The review request is invalid.");
    const { workspaceId, fileIds } = request.data;
    const wanted = new Set(fileIds);

    const portCtx: PortContext = { caller: { actor: identity.actor, connectionId: identity.connectionId, windowId: identity.windowId }, signal: context.signal };
    let round: ReviewRound;
    const rows: ReviewContentFile[] = [];
    const found = new Set<string>();
    try {
      round = await deps.review.open(workspaceId, portCtx);
      // The diff's own order: protected first (WT-3), then the review's order; equal path strings are one unsafe row.
      let left = MAX_CONTENT_RESPONSE_CHARS;
      for (const f of protectedFirst(foldEqualPaths(round.files))) {
        const fileId = fileIdOf(f.path);
        if (!wanted.has(fileId) || found.has(fileId)) continue;
        found.add(fileId);
        if (context.signal.aborted) return fail("E_CANCELLED", "The request was cancelled.");
        const view = await viewOf(round, f, Math.min(MAX_CONTENT_FILE_CHARS, left));
        left -= viewChars(view);
        rows.push(row(f, fileId, view));
      }
    } catch (e) {
      return mapRefusal(e);
    }
    if (context.signal.aborted) return fail("E_CANCELLED", "The request was cancelled.");
    const answer = reviewContentResponseSchema.safeParse({ head: round.head, files: rows, notFound: fileIds.filter((id) => !found.has(id)) });
    if (!answer.success) return fail("E_INTERNAL", "The review could not be completed.");
    return answer.data;
  };
}

/** What the file would commit, decided by the snapshot entry's mode and bytes (never by the listed kind, which reads attributes). */
async function viewOf(round: ReviewRound, f: RoundFile, budget: number): Promise<ContentView> {
  if (f.unsafePath || hasReplacementChar(f.path)) return { kind: "unavailable", reason: "unsafe_path" };
  // A content filter's file holds the smudged bytes (plaintext of an encrypted file, say): never shown, never acknowledgeable.
  if (f.kind === "filtered") return { kind: "unavailable", reason: "filtered" };
  if (f.status === "D" || f.newMode === "000000") return { kind: "deleted" };
  if (f.newMode === "160000") return { kind: "submodule", commit: f.newOid };
  const blob = await round.readNewBlob(f.path);
  if (f.newMode === "120000") return linkView(blob.bytes, f.warnings.includes("symlink-outside") || !blob.complete, budget);
  return fileView(blob, f.newOid, budget);
}

function row(f: RoundFile, fileId: string, view: ContentView): ReviewContentFile {
  return {
    fileId,
    displayPath: toDisplayPath(f.path, MAX_REVIEW_PATH),
    ...(f.oldPath === undefined ? {} : { displayOldPath: toDisplayPath(f.oldPath, MAX_REVIEW_PATH) }),
    protectedPath: isProtected(f),
    protectedRules: f.protectedRules.slice(0, 4).map((s) => toDisplayPath(s, 64)),
    // The same id `diff` computes from the same entry, so an acknowledgement names exactly the content shown here.
    contentId: view.kind === "unavailable" ? null : contentIdOf(f.newMode, f.newOid, isProtected(f)),
    view,
  };
}
