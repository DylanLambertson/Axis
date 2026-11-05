// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DaemonError } from "@axis/daemon";
import type { ReviewHandle } from "../ports/review.js";

/** What `diff` minted for one reviewed tree. `handle` is for the git handler's own binding; nothing here reads it. */
export interface ReviewedTree {
  readonly workspaceId: string;
  readonly treeHash: string;
  /** The commit the review is against: the `expectedParent` of the commit. */
  readonly parent: string;
  /** The short branch name. */
  readonly branch: string;
  readonly handle: ReviewHandle;
}

export interface ReviewedTreesLimits {
  /** Workspaces remembered; the least recently reviewed one is forgotten first. */
  readonly maxWorkspaces: number;
  /** Trees remembered per workspace; the oldest is forgotten first. */
  readonly maxPerWorkspace: number;
}
export const DEFAULT_REVIEWED_TREES_LIMITS: ReviewedTreesLimits = Object.freeze({ maxWorkspaces: 256, maxPerWorkspace: 8 });

/**
 * The reviewed trees the `diff` handler has produced, in memory and bounded (REV-1). The git `commit` handler asks
 * `lookupReviewedTree(workspaceId, treeHash)` and gets the binding or a refusal: a hash this process did not produce for
 * THAT workspace (a guess, another workspace's tree, a tree from before a restart, one forgotten for the bound) is
 * `E_CONFLICT` `stale`. Forgetting is the safe direction: the user reviews again.
 */
export class ReviewedTrees {
  readonly #limits: ReviewedTreesLimits;
  readonly #byWorkspace = new Map<string, ReviewedTree[]>();

  constructor(limits: Partial<ReviewedTreesLimits> = {}) {
    this.#limits = { ...DEFAULT_REVIEWED_TREES_LIMITS, ...limits };
    for (const v of Object.values(this.#limits)) if (!Number.isInteger(v) || v < 1) throw new RangeError("review store limits must be positive integers");
  }

  record(entry: ReviewedTree): void {
    const list = (this.#byWorkspace.get(entry.workspaceId) ?? []).filter((e) => e.treeHash !== entry.treeHash);
    list.push(entry);
    while (list.length > this.#limits.maxPerWorkspace) list.shift();
    // Re-inserting moves the workspace to the newest position.
    this.#byWorkspace.delete(entry.workspaceId);
    this.#byWorkspace.set(entry.workspaceId, list);
    while (this.#byWorkspace.size > this.#limits.maxWorkspaces) {
      const oldest = this.#byWorkspace.keys().next();
      if (oldest.done === true) break;
      this.#byWorkspace.delete(oldest.value);
    }
  }

  /** Throws `DaemonError` `E_CONFLICT` (`stale`) unless a diff of this workspace produced exactly this hash. */
  lookupReviewedTree(workspaceId: string, treeHash: string): ReviewedTree {
    const hit = this.#byWorkspace.get(workspaceId)?.find((e) => e.treeHash === treeHash);
    if (hit === undefined) throw new DaemonError("E_CONFLICT", "That reviewed state is not available. Review the changes again.", { reason: "stale" });
    return hit;
  }

  /** Forget a workspace's trees (it was removed or committed). */
  forget(workspaceId: string): void {
    this.#byWorkspace.delete(workspaceId);
  }

  get size(): number {
    return this.#byWorkspace.size;
  }
}
