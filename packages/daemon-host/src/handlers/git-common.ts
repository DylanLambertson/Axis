// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError, type HandlerContext } from "@axis/daemon";
import type { Journal, Workspace } from "@axis/journal";
import type { AnchorGuard } from "../anchor/manager.js";
import type { PortContext } from "../ports/common.js";
import type { GitOperations } from "../ports/git.js";
import type { CommitPreparer } from "../ports/review.js";
import type { RunsService } from "../ports/runs.js";
import type { WorktreeLocator } from "../ports/worktree-locator.js";
import { liveWorkspace } from "../worktrees/guards.js";
import type { ProjectMutex } from "../worktrees/project-mutex.js";
import { gitFailure } from "./git-errors.js";
import type { ReviewedTrees } from "./review-store.js";

export interface GitHandlerDeps {
  readonly ops: GitOperations;
  /** The commit side of the review binding; the handle of a reviewed tree is only ever passed to it. */
  readonly review: CommitPreparer;
  readonly trees: Pick<ReviewedTrees, "lookupReviewedTree" | "forget">;
  readonly journal: Pick<Journal, "getWorkspace" | "recordPushed">;
  readonly locator: WorktreeLocator;
  /** The ONE project mutex of the worktrees binding (`WorktreesBinding.mutex`): commit, push and the worktree calls exclude each other. */
  readonly mutex: ProjectMutex;
  readonly needsAttention: (workspaceId: string, method?: string) => boolean;
  /** Checked first by the push content hook, so a stalled anchor does no scan and issues no challenge. */
  readonly anchors: Pick<AnchorGuard, "check">;
  /** For the early refusal of a push while a run is live in the workspace. A throw counts as active. */
  readonly runs: Pick<RunsService, "hasActiveRun">;
  /** The scanner and its mode as the git port carries them: `git.push` is not registered without both (PSH-1). */
  readonly scan: { readonly scanner?: unknown; readonly scanMode?: unknown };
  /** A bookkeeping write that failed AFTER its git side effect succeeded (the last pushed sha). The reply is still the success. */
  readonly onBookkeepingError?: (error: unknown) => void;
}

export function portContext(context: HandlerContext): PortContext {
  const { identity, signal } = context;
  return { caller: { actor: identity.actor, connectionId: identity.connectionId, windowId: identity.windowId }, signal };
}

/** Only the user's own attested connection works on workspaces, whatever the policy table says. */
export function requireUser(context: HandlerContext): void {
  if (context.signal.aborted) throw gitFailure("E_CANCELLED");
  if (context.identity.actor !== "user") throw gitFailure("E_NOT_FOUND");
}

/**
 * The journal row of a workspace the caller named, refused when it is gone (`E_NOT_FOUND`), needs attention
 * (`E_UNAVAILABLE`) or, with `ready`, is not READY (`E_CONFLICT`). Read again inside the lock by every handler: a row read
 * before the lock may be stale when the lock is taken.
 */
export function workspaceFor(deps: GitHandlerDeps, id: string, method: string, ready: boolean): Workspace {
  let ws: Workspace;
  try {
    ws = liveWorkspace(deps.journal, id);
  } catch (e) {
    if (e instanceof DaemonError) throw gitFailure("E_NOT_FOUND");
    throw gitFailure("E_INTERNAL");
  }
  if (deps.needsAttention(ws.id, method)) throw new DaemonError("E_UNAVAILABLE", "This workspace needs attention and is unavailable.", { reason: "needs_attention" });
  if (ready && ws.state !== "READY") throw new DaemonError("E_CONFLICT", "The workspace is not ready for this.");
  return ws;
}

/** The registered worktree of a workspace, from the journal through the locator; the locator's own text is never forwarded. */
export async function locate(deps: GitHandlerDeps, id: string) {
  try {
    return await deps.locator.locate(id);
  } catch (e) {
    throw gitFailure((e as { code?: unknown } | null)?.code === "E_NOT_FOUND" ? "E_NOT_FOUND" : "E_UNAVAILABLE");
  }
}

/** True while the supervisor says a run is live in the workspace; a supervisor that cannot answer counts as active. */
export function runActive(deps: GitHandlerDeps, workspaceId: string): boolean {
  try {
    return deps.runs.hasActiveRun(workspaceId);
  } catch {
    return true;
  }
}
