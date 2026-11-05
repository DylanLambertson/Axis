// Copyright (c) 2026 Dylan Lambertson. All rights reserved.

/**
 * Run state machine, Phase 1a subset of `docs/AGENT_SYSTEM.md`:
 *
 *   QUEUED -> RUNNING -> REVIEWING -> COMPLETED
 *
 * with side exits to FAILED, CANCELLED and BLOCKED. Full set in the document:
 * DRAFT, PLANNING, AWAITING_APPROVAL, QUEUED, RUNNING, VALIDATING, REVIEWING,
 * READY_TO_MERGE, MERGING, COMPLETED, CANCELLED, FAILED, BLOCKED, ROLLED_BACK.
 * Not in the 1a subset (they need the planner, approvals, validation or the
 * merge queue, all Phase 1b or later): DRAFT, PLANNING, AWAITING_APPROVAL,
 * VALIDATING, READY_TO_MERGE, MERGING, ROLLED_BACK.
 *
 * Every run reaches COMPLETED through REVIEWING (AGENT_SYSTEM.md routes every
 * run through review; CLI runs' changes go through diff review). A run that
 * produced nothing still passes REVIEWING and is accepted from there. In
 * Phase 1a the acceptance is the user's: `transitionRun(.., "COMPLETED")`
 * from REVIEWING is denied (E_POLICY_DENIED) unless its actor is `user`, so
 * neither the agent that did the work nor the daemon on its own can approve
 * it. A later reviewer role (Phase 3) widens this by its own decision.
 *
 * BLOCKED is the "interrupted" state, and it is resumable, unlike the
 * "alternative terminal" BLOCKED of AGENT_SYSTEM.md (recorded there too). A run that was RUNNING when the daemon
 * died becomes BLOCKED with reason `INTERRUPTED_BY_RESTART`; the user (or the
 * supervisor) then retries it (BLOCKED -> QUEUED), re-adopts a still-live CLI
 * process (BLOCKED -> RUNNING) or cancels it.
 */
export const RUN_STATES = ["QUEUED", "RUNNING", "REVIEWING", "BLOCKED", "COMPLETED", "FAILED", "CANCELLED"] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RUN_KINDS = ["composer", "cli"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  QUEUED: ["RUNNING", "CANCELLED"],
  RUNNING: ["REVIEWING", "FAILED", "CANCELLED", "BLOCKED"],
  REVIEWING: ["COMPLETED", "FAILED", "CANCELLED"],
  BLOCKED: ["QUEUED", "RUNNING", "CANCELLED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export const RUN_TERMINAL_STATES: readonly RunState[] = ["COMPLETED", "FAILED", "CANCELLED"];

/**
 * Workspace lifecycle: CREATING -> READY -> (FINALISED ->) REMOVING -> REMOVED, plus FAILED
 * when creation does not finish. REMOVING can fall back to the state it came from (READY or
 * FINALISED) when removal is refused or fails cleanly. (The design's `agent_workspaces.state`
 * starts at READY; CREATING and REMOVING exist so a crash between the journal write and the Git
 * operation is visible and recoverable, journal-first.)
 *
 * Names against the other packages: `@axis/worktrees` and the protocol say READY and FINALISED
 * under the same names. The protocol's CLEANED is this journal's REMOVED (wire name for the same
 * end state; the host maps it, the journal does not store two names). CREATING, REMOVING and
 * FAILED are journal-only crash-visibility states and are never sent on the wire as such.
 */
export const WORKSPACE_STATES = ["CREATING", "READY", "FINALISED", "REMOVING", "REMOVED", "FAILED"] as const;
export type WorkspaceState = (typeof WORKSPACE_STATES)[number];

export const WORKSPACE_TRANSITIONS: Readonly<Record<WorkspaceState, readonly WorkspaceState[]>> = {
  CREATING: ["READY", "FAILED"],
  READY: ["FINALISED", "REMOVING"],
  FINALISED: ["REMOVING"],
  REMOVING: ["REMOVED", "READY", "FINALISED"],
  REMOVED: [],
  FAILED: [],
};

export const FINALISE_OUTCOMES = ["merged", "archived", "abandoned"] as const;
export type FinaliseOutcome = (typeof FINALISE_OUTCOMES)[number];

export const LOCK_STATES = ["unlocked", "locked"] as const;
export type LockState = (typeof LOCK_STATES)[number];

export const RESTART_REASON = "INTERRUPTED_BY_RESTART";
