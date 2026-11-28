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

/** The plain terminals of a workspace, as finalise and remove see them (DC-3a; terminal-trust-revocation.md section 7). */
export interface WorkspaceTerminals {
  /** Abandons the workspace's pending opens and closes its live plain terminals; true while any of its slots is still charged. */
  closeWorkspace(workspaceId: string): boolean;
  /** True while any of the workspace's slots is still charged (a group alive or an outcome unknown). */
  busy(workspaceId: string): boolean;
}

/** How long finalise and remove wait for the killed groups to go before refusing (review N1): a kill is a message to the pty process. */
export const TERMINALS_GONE_WAIT_MS = 2_000;
const POLL_MS = 25;

/**
 * Before finalise or remove: the workspace's plain terminals are closed first; then the call waits, at most
 * `TERMINALS_GONE_WAIT_MS`, for their groups to be gone, and is refused (`active_run`, as for a run) if any may still live. Fails
 * closed: a throw counts as busy. A cancellation of the request ends the wait with its abort.
 */
export async function closeWorkspaceTerminals(terminals: WorkspaceTerminals | undefined, workspaceId: string, signal?: AbortSignal, waitMs = TERMINALS_GONE_WAIT_MS): Promise<void> {
  if (terminals === undefined) return;
  const busy = (first: boolean): boolean => {
    try {
      return first ? terminals.closeWorkspace(workspaceId) : terminals.busy(workspaceId);
    } catch {
      return true;
    }
  };
  let still = busy(true);
  for (let waited = 0; still && waited < waitMs; waited += POLL_MS) {
    signal?.throwIfAborted(); // review 2 nit 4: a cancelled request stops waiting (the terminals are already closed)
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
    still = busy(false);
  }
  if (still) throw worktreeFailure("E_CONFLICT", "active_run");
}
