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
import { GitRefusal } from "../ports/git.js";
import { ReviewRefusal } from "../ports/review.js";
import { toGitError } from "./git-errors.js";
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
  /**
   * What was pushed to each remote, per workspace (the scan base). In memory and bounded: a remote
   * with no entry (never pushed, forgotten for the bound, or a restart) is scanned from the workspace's recorded base, which
   * is only ever a larger range.
   */
  readonly bases: PushedBases;
  /** Told about an error that is not a refusal (a bug in a binding): the wire says `E_INTERNAL` and nothing else. */
  readonly onInternalError?: (error: unknown) => void;
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

/**
 * The scan base of a push of `workspaceId` to the destination `target` (a hash of the resolved push URLs, see
 * `GitOperations.pushTarget`): what Axis last pushed THERE, else the workspace's recorded base. The journal's last pushed sha is
 * per workspace and the destination is chosen per request, so it is no base for another one; and the key is the destination,
 * not the remote's name, so a remote that is re-pointed after a push misses (and is scanned from the recorded base) while two
 * names for one URL share an entry (the same destination). Only a hash is kept, never a URL (userinfo). Bounded; eviction
 * only widens a later scan.
 */
export class PushedBases {
  readonly #map = new Map<string, string>();
  constructor(readonly max = 1024) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError("the bound must be a positive integer");
  }

  baseFor(workspaceId: string, target: string, recordedBase: string): string {
    return this.#map.get(`${workspaceId}\0${target}`) ?? recordedBase;
  }

  record(workspaceId: string, target: string, sha: string): void {
    const key = `${workspaceId}\0${target}`;
    this.#map.delete(key);
    this.#map.set(key, sha);
    while (this.#map.size > this.max) {
      const oldest = this.#map.keys().next();
      if (oldest.done === true) break;
      this.#map.delete(oldest.value);
    }
  }

  get size(): number {
    return this.#map.size;
  }
}

/** `toGitError`, and a report when the cause was no refusal of ours. A reporter that throws changes nothing. */
export function mapError(deps: GitHandlerDeps, e: unknown, signal?: AbortSignal) {
  const out = toGitError(e, signal);
  if (!(e instanceof DaemonError || e instanceof GitRefusal || e instanceof ReviewRefusal)) {
    try {
      deps.onInternalError?.(e);
    } catch {
      /* reporting must not change the answer */
    }
  }
  return out;
}
