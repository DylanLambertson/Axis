// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { AxisError } from "@axis/audit";
import type { Handler, HandlerContext } from "@axis/daemon";
import {
  axisBranchSchema,
  CONTENT_LEADING_REFUSED,
  CONTENT_REFUSED,
  hunksReplyFits,
  MAX_HUNK_LINE_CHARS,
  MAX_HUNKS_REPLY_CHARS,
  MAX_HUNKS_REPLY_HUNKS,
  MAX_HUNKS_REPLY_LINES,
  reviewBuildReasonSchema,
  reviewBuildRequestSchema,
  reviewBuildResponseSchema,
  reviewHunksFileLevelReasonSchema,
  reviewHunksReasonSchema,
  reviewHunksRequestSchema,
  reviewHunksResponseSchema,
  type HunkWire,
  type ReviewHunksFileLevelReason,
  type ReviewHunksResponse,
  type SelectionItem,
} from "@axis/protocol";
import type { PortContext } from "../ports/common.js";
import type { ReviewRound, RoundFile, RoundHunk } from "../ports/review.js";
import type { ReviewHandlerDeps } from "./review.js";
import { fail, mapRefusal, NOT_AVAILABLE } from "./review-errors.js";
import { AckSessions, fileIdOf, foldEqualPaths, hasReplacementChar, isProtected, mapLimit, versionIdOf } from "./review-wire.js";

/**
 * `axis.review/1.hunks` and `axis.review/1.build` (DC-2, docs/design/review-hunks-build.md), both read at tier 1, user only.
 *
 * As `diff`: the actor is checked here as well as by the policy row, every request opens a new round, every error text is
 * fixed, and a handler never raises `E_POLICY_DENIED` (the core's policy refusals become `E_CONFLICT`, `review-errors.ts`).
 * `build` checks the selection in the note's order, validates its reply before any acceptance, audit or registration, and
 * registers the tree exactly as `diff` does (journal, then `ReviewedTrees`), so `axis.git/1.commit` is unchanged.
 */

const LOAD_CONCURRENCY = 8;
const cancelled = (): never => fail("E_CANCELLED", "The request was cancelled.");

/**
 * The core escapes controls, bidi and zero-width characters; the wire refuses a slightly wider set (every format character,
 * the invisible fillers, a combining mark that would lead the line). What is left of that set is written as `\u{hex}` here,
 * so a valid file never fails the reply schema. The core already wrote a literal backslash as `\\`, so this escape cannot be
 * confused with file text, and it only ever ADDS visible text: nothing is cut, and the cut flags stay the core's (REV-1).
 */
export function wireText(text: string): string {
  let out = "";
  let first = true;
  for (const ch of text) {
    out += CONTENT_REFUSED.test(ch) || (first && CONTENT_LEADING_REFUSED.test(ch)) ? `\\u{${(ch.codePointAt(0) as number).toString(16)}}` : ch;
    first = false;
  }
  return out;
}

const toWire = (h: RoundHunk): HunkWire => ({
  id: h.id,
  header: h.header,
  lines: h.lines.map((l) => ({ kind: l.kind, text: wireText(l.text), eol: l.eol, truncated: l.truncated })),
  truncated: h.truncated,
});

/** The four bounds of the note, checked before the schema so the fallback never depends on a refinement's message. */
function withinBounds(hunks: readonly HunkWire[]): boolean {
  if (hunks.length > MAX_HUNKS_REPLY_HUNKS) return false;
  let lines = 0;
  let chars = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.text.length > MAX_HUNK_LINE_CHARS) return false;
      lines++;
      chars += l.text.length;
    }
  }
  return lines <= MAX_HUNKS_REPLY_LINES && chars <= MAX_HUNKS_REPLY_CHARS;
}

/**
 * The reply `hunks` sends for loaded hunks, or undefined when it would not fit (`over_view_budget`). `build` asks the same
 * question, so a file shown as a whole-file decision can never be selected by hunk ids.
 */
function hunksView(base: { readonly head: string; readonly fileId: string; readonly versionId: string }, loaded: readonly RoundHunk[]): ReviewHunksResponse | undefined {
  const hunks = loaded.map(toWire);
  const candidate = { ...base, hunks };
  // All or nothing: a reply over any bound, or over the message walk's headroom, is a whole-file decision, never a part.
  if (!withinBounds(hunks) || !hunksReplyFits(candidate)) return undefined;
  return reviewHunksResponseSchema.parse(candidate);
}

const fileLevel = (reason: string): ReviewHunksFileLevelReason => {
  const r = reviewHunksFileLevelReasonSchema.safeParse(reason);
  return r.success ? r.data : "unreadable";
};

interface Located {
  readonly file: RoundFile;
  readonly fileId: string;
  readonly versionId: string;
  readonly unsafe: boolean;
  readonly filtered: boolean;
}

/** The round's files by `fileId`, equal path strings folded into one unsafe entry as `diff` folds them. */
function locate(round: ReviewRound): Map<string, Located> {
  const out = new Map<string, Located>();
  for (const f of foldEqualPaths(round.files)) {
    const fileId = fileIdOf(f.path);
    out.set(fileId, { file: f, fileId, versionId: versionIdOf(f, isProtected(f)), unsafe: f.unsafePath || hasReplacementChar(f.path), filtered: f.kind === "filtered" });
  }
  return out;
}

const portCtxOf = (context: HandlerContext): PortContext => ({
  caller: { actor: context.identity.actor, connectionId: context.identity.connectionId, windowId: context.identity.windowId },
  signal: context.signal,
});

export function createReviewHunksHandler(deps: ReviewHandlerDeps): Handler {
  return async (context: HandlerContext, payload: never) => {
    if (context.signal.aborted) return cancelled();
    if (context.identity.actor !== "user") return fail("E_NOT_FOUND", NOT_AVAILABLE);
    const request = reviewHunksRequestSchema.safeParse(payload);
    if (!request.success) return fail("E_INVALID_ARGUMENT", "The review request is invalid.");
    const { workspaceId, fileId } = request.data;
    let head: string;
    let found: Located | undefined;
    let loaded: { kind: "hunks"; hunks: readonly RoundHunk[] } | { kind: "file-level"; reason: string };
    try {
      const round = await deps.review.open(workspaceId, portCtxOf(context));
      head = round.head;
      found = locate(round).get(fileId);
      if (found === undefined) return fail("E_NOT_FOUND", "The file is not part of this review.", "file_not_found");
      // A file that cannot be accepted is never read for hunks.
      if (found.unsafe) loaded = { kind: "file-level", reason: "unsafe_path" };
      else if (found.filtered) loaded = { kind: "file-level", reason: "filtered_path" };
      else loaded = await round.hunks(found.file.path);
    } catch (e) {
      return mapRefusal(e, reviewHunksReasonSchema);
    }
    if (context.signal.aborted) return cancelled();
    const base = { head, fileId, versionId: found.versionId };
    if (loaded.kind === "hunks") {
      const view = hunksView(base, loaded.hunks);
      if (view !== undefined) return view;
      loaded = { kind: "file-level", reason: "over_view_budget" };
    }
    const answer = reviewHunksResponseSchema.safeParse({ ...base, fileLevelReason: fileLevel(loaded.reason) });
    if (!answer.success) return fail("E_INTERNAL", "The review could not be completed.");
    return answer.data;
  };
}

interface Planned {
  readonly item: SelectionItem;
  readonly at: Located;
  /** Whole file: accept with this acknowledgement. Hunks: each id with its own. */
  readonly accepts: readonly { readonly hunkId?: string; readonly acceptTruncated: boolean }[];
  readonly acknowledged: boolean;
  readonly echo: SelectionItem;
}

/**
 * Records a built tree in the journal as the user. Supplied by `review.ts`, the one file allowed to mint the `UserPrincipal`
 * (the import fence in `test/packages/imports.test.mjs`): this handler never holds the principal itself.
 */
export type RecordAsUser = (workspaceId: string, treeHash: string) => void;

export function createReviewBuildHandler(deps: ReviewHandlerDeps, recordAsUser: RecordAsUser): Handler {
  const acks = deps.acks ?? new AckSessions();
  return async (context: HandlerContext, payload: never) => {
    if (context.signal.aborted) return cancelled();
    const { identity } = context;
    if (identity.actor !== "user") return fail("E_NOT_FOUND", NOT_AVAILABLE);
    const request = reviewBuildRequestSchema.safeParse(payload);
    if (!request.success) return fail("E_INVALID_ARGUMENT", "The review request is invalid.");
    const { workspaceId, head, selection } = request.data;
    const refuse = (e: unknown): never => mapRefusal(e, reviewBuildReasonSchema);

    let round: ReviewRound;
    try {
      round = await deps.review.open(workspaceId, portCtxOf(context));
    } catch (e) {
      return refuse(e);
    }
    // 1. The round's HEAD and the workspace's own branch.
    if (round.head !== head) return fail("E_CONFLICT", "HEAD moved since the hunks were read.", "head_moved");
    let ownBranch: string | undefined;
    try {
      ownBranch = deps.journal.getWorkspace(workspaceId)?.branch;
    } catch {
      return fail("E_INTERNAL", "The review could not be completed.");
    }
    if (!axisBranchSchema.safeParse(round.branch).success || round.branch !== ownBranch || ownBranch === undefined) {
      return fail("E_CONFLICT", "The workspace's own branch is not checked out.", "not_head");
    }
    // 2. Every file in this round, at the version the user saw.
    const files = locate(round);
    const located: Located[] = [];
    for (const item of selection) {
      const at = files.get(item.fileId);
      if (at === undefined) return fail("E_NOT_FOUND", "A selected file is not part of this review.", "file_not_found");
      if (at.versionId !== item.versionId) return fail("E_CONFLICT", "A selected file changed since it was shown.", "selection_stale");
      located.push(at);
    }
    // 3. Usable: no unusable path, no content filter.
    for (const at of located) {
      if (at.unsafe) return fail("E_CONFLICT", "A selected file cannot be accepted.", "unsafe_path");
      if (at.filtered) return fail("E_CONFLICT", "A selected file cannot be accepted.", "filtered_path");
    }
    // 4 and 5. What this round would accept for each item, with the acknowledgement only where this round cuts.
    let planned: Planned[];
    try {
      planned = await mapLimit(selection.map((item, i) => ({ item, at: located[i] as Located })), LOAD_CONCURRENCY, async ({ item, at }): Promise<Planned> => {
        if ("whole" in item) {
          const cut = await round.hasCutLines(at.file.path);
          if (cut && item.acknowledged !== true) throw new Refused("truncated_hunk");
          const ack = cut && item.acknowledged === true;
          return { item, at, accepts: [{ acceptTruncated: ack }], acknowledged: ack, echo: { fileId: item.fileId, versionId: item.versionId, whole: true, ...(ack ? { acknowledged: true as const } : {}) } };
        }
        const loaded = await round.hunks(at.file.path);
        // Exactly the files `hunks` offers hunks for: one over the reply's bounds was shown as a whole-file decision.
        if (loaded.kind !== "hunks" || hunksView({ head: round.head, fileId: at.fileId, versionId: at.versionId }, loaded.hunks) === undefined) throw new Refused("no_hunks");
        const byId = new Map(loaded.hunks.map((h) => [h.id, h]));
        const acked = new Set(item.acknowledgedHunkIds ?? []);
        const accepts: { hunkId: string; acceptTruncated: boolean }[] = [];
        for (const id of item.hunkIds) {
          const h = byId.get(id);
          if (h === undefined) throw new Refused("selection_stale");
          if (h.truncated && !acked.has(id)) throw new Refused("truncated_hunk");
          accepts.push({ hunkId: id, acceptTruncated: h.truncated && acked.has(id) });
        }
        const ackIds = accepts.filter((a) => a.acceptTruncated).map((a) => a.hunkId);
        // Every hunk selected is the whole file in the core (mode and rename included), so it is reported as one.
        const echo: SelectionItem =
          accepts.length === loaded.hunks.length
            ? { fileId: item.fileId, versionId: item.versionId, whole: true }
            : { fileId: item.fileId, versionId: item.versionId, hunkIds: [...item.hunkIds], ...(ackIds.length > 0 ? { acknowledgedHunkIds: ackIds } : {}) };
        return { item, at, accepts, acknowledged: ackIds.length > 0, echo };
      });
    } catch (e) {
      if (e instanceof Refused) return refusedBy(e.reason);
      return refuse(e);
    }
    if (context.signal.aborted) return cancelled();

    // The reply must be one the contract accepts BEFORE anything is accepted, audited or recorded.
    const reply = (treeHash: string) => reviewBuildResponseSchema.safeParse({ head: round.head, branch: ownBranch, treeHash, selection: planned.map((p) => p.echo) });
    if (!reply("0".repeat(round.head.length)).success) return fail("E_INTERNAL", "The review could not be completed.");

    try {
      for (const p of planned) {
        for (const a of p.accepts) {
          if (a.hunkId === undefined) round.accept(p.at.file.path, { acceptTruncated: a.acceptTruncated });
          else round.acceptHunk(p.at.file.path, a.hunkId, { acceptTruncated: a.acceptTruncated });
        }
      }
    } catch (e) {
      return refuse(e);
    }
    // One audit event per first application of an acknowledgement in this session, by fileId only, before any tree exists.
    const session = `build\u0000${workspaceId}\u0000${identity.connectionId}\u0000${round.head}`;
    for (const p of planned) {
      if (!p.acknowledged || !acks.isFirst(session, p.at.fileId, p.at.versionId)) continue;
      try {
        deps.audit.append({ action: "review.acknowledge", actor: "user", workspaceId, connectionId: identity.connectionId, fileId: p.at.fileId });
      } catch {
        return fail("E_INTERNAL", "The review could not be recorded.");
      }
      acks.commit(session, p.at.fileId, p.at.versionId);
    }
    let built;
    try {
      built = await round.build();
    } catch (e) {
      return refuse(e);
    }
    // A request that timed out or was cancelled while the tree was built records nothing.
    if (context.signal.aborted) return cancelled();
    if (built.branch !== ownBranch || built.head !== round.head) return fail("E_CONFLICT", "The workspace's own branch is not checked out.", "not_head");
    // The reply with the real tree is checked before the tree is registered: a tree no one can be shown is not recorded.
    const answer = reply(built.reviewedTree);
    if (!answer.success) return fail("E_INTERNAL", "The review could not be completed.");
    try {
      // Journal first (it needs the minted principal and a READY workspace); the lookup is filled only when it succeeded.
      recordAsUser(workspaceId, built.reviewedTree);
    } catch (e) {
      if (e instanceof AxisError && e.code === "E_CONFLICT") return fail("E_CONFLICT", "The review could not be recorded for this workspace.");
      return fail("E_INTERNAL", "The review could not be recorded.");
    }
    deps.trees.record({ workspaceId, treeHash: built.reviewedTree, parent: built.head, branch: built.branch, handle: built.handle });
    return answer.data;
  };
}

/** A refusal decided while the selection is planned (inside the concurrent loads), turned into its wire error afterwards. */
class Refused extends Error {
  constructor(readonly reason: "truncated_hunk" | "no_hunks" | "selection_stale") {
    super("refused");
  }
}

function refusedBy(reason: Refused["reason"]): never {
  if (reason === "no_hunks") return fail("E_INVALID_ARGUMENT", "A selected file offers only a whole-file decision.", "no_hunks");
  if (reason === "selection_stale") return fail("E_CONFLICT", "A selected hunk is not part of this review.", "selection_stale");
  return fail("E_CONFLICT", "A selected line is longer than the view shows; acknowledge it first.", "truncated_hunk");
}
