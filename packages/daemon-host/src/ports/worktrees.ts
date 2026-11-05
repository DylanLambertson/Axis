// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { WorktreesRequest, WorktreesResponse } from "@axis/protocol";
import type { PortContext } from "./common.js";

/** What discarding a workspace would lose, and the fingerprint that binds an approval to exactly that. */
export interface DiscardPreview {
  /** The `contentDigest` of the approval. Metadata only, never file content. */
  readonly fingerprint: string;
  readonly dirtyFiles: number;
  /** The native confirmation must show these: a backup does not hold them. */
  readonly skippedLarge: number;
  readonly ignored: number;
  readonly skippedUnsupported: number;
}

/**
 * `finalise_incomplete` is the one reason that does not block its own repair: the journal says READY, the manager's record says
 * FINALISED and the archive ref exists (what a crash between git and the journal leaves). Only an explicit `finalise` call
 * may proceed on it, and that call re-verifies the state with git itself before it records anything.
 */
export const RECONCILE_REASONS = ["missing_worktree", "unknown_worktree", "ref_mismatch", "finalise_incomplete", "timeout", "failed"] as const;
export type ReconcileReason = (typeof RECONCILE_REASONS)[number];

export interface ReconcileReport {
  /** True when the report is not the whole truth (the cap on entries was reached): every workspace then counts as needing attention. */
  readonly incomplete?: boolean;
  /** Workspaces that answer `E_UNAVAILABLE` until looked at. Never aborts startup. */
  readonly needsAttention: readonly { readonly workspaceId: string; readonly reason: ReconcileReason }[];
}

/**
 * Worktrees by id, with the `axis.worktrees/1` request and response shapes of `@axis/protocol`. The contract
 * is id-based and so is this port: the implementation turns ids into paths itself, at the moment of use (DMN-2),
 * and handlers never see a path. Rejects with `AxisError`.
 */
export interface WorktreesService {
  list(req: WorktreesRequest<"list">, ctx: PortContext): Promise<WorktreesResponse<"list">>;
  status(req: WorktreesRequest<"status">, ctx: PortContext): Promise<WorktreesResponse<"status">>;
  create(req: WorktreesRequest<"create">, ctx: PortContext): Promise<WorktreesResponse<"create">>;
  finalise(req: WorktreesRequest<"finalise">, ctx: PortContext): Promise<WorktreesResponse<"finalise">>;
  remove(req: WorktreesRequest<"remove">, ctx: PortContext): Promise<WorktreesResponse<"remove">>;
  restoreFromRunBase(
    req: WorktreesRequest<"restoreFromRunBase">,
    ctx: PortContext,
  ): Promise<WorktreesResponse<"restoreFromRunBase">>;
  previewDiscard(workspaceId: string, ctx: PortContext): Promise<DiscardPreview>;
  /** Rejects `E_CONFLICT` when the worktree drifted from its recorded snapshot (GIT-SNAP-1). */
  assertNoDrift(workspaceId: string, ctx: PortContext): Promise<void>;
  /** Compare `git worktree list` and `refs/axis/*` with the journal (G-12). Bounded by the caller's signal. */
  reconcile(signal: AbortSignal): Promise<ReconcileReport>;
}
