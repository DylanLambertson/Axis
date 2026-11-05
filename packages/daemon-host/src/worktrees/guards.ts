// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { RUN_STATES, RUN_TERMINAL_STATES, type Journal, type RunState, type Workspace } from "@axis/journal";
import type { RunsService } from "../ports/runs.js";
import { worktreeFailure } from "./errors.js";

const OPEN_RUN_STATES: readonly RunState[] = RUN_STATES.filter((s) => !RUN_TERMINAL_STATES.includes(s));

export type GuardJournal = Pick<Journal, "getWorkspace" | "listRuns">;

/** The live journal row of a workspace the caller named, or `E_NOT_FOUND` (one answer for unknown and gone). */
export function liveWorkspace(journal: Pick<Journal, "getWorkspace">, id: string): Workspace {
  const ws = journal.getWorkspace(id);
  if (ws === undefined || ws.state === "REMOVED" || ws.state === "FAILED" || ws.state === "CREATING") throw worktreeFailure("E_NOT_FOUND");
  return ws;
}

/**
 * Refuse while a run could still touch the workspace: the supervisor's live view (`hasActiveRun`: a process may be
 * running) and the journal's (any run not in a terminal state, which the journal itself refuses to finalise or remove
 * under). Checked BEFORE any change, so a refusal leaves no half-done operation behind. Fails closed: a throw
 * from the supervisor counts as active.
 */
export function assertNoActiveRun(journal: GuardJournal, runs: Pick<RunsService, "hasActiveRun">, workspaceId: string): void {
  let active = true;
  try {
    active = runs.hasActiveRun(workspaceId);
  } catch {
    active = true;
  }
  if (active || journal.listRuns({ workspaceId, states: OPEN_RUN_STATES }).length > 0) throw worktreeFailure("E_CONFLICT", "active_run");
}
