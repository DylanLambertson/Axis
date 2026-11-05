// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import type { PortContext } from "./common.js";

export const RUN_STATES = ["QUEUED", "RUNNING", "REVIEWING", "BLOCKED", "COMPLETED", "FAILED", "CANCELLED"] as const;
export type RunState = (typeof RUN_STATES)[number];

export interface RunStartRequest {
  readonly workspaceId: string;
  /** A key of the `axis.cliAgents` setting, never a command line. */
  readonly agentId: string;
}

export interface RunSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly state: RunState;
  /** Why a BLOCKED, FAILED or CANCELLED run ended, as a closed code such as `INTERRUPTED_BY_RESTART`. */
  readonly reason?: string;
}

/** CLI run lifecycle over the journal. Ids only: no path and no command line crosses this port. */
export interface RunsService {
  start(req: RunStartRequest, ctx: PortContext): Promise<RunSummary>;
  stop(runId: string, ctx: PortContext): Promise<RunSummary>;
  get(runId: string, ctx: PortContext): Promise<RunSummary>;
  list(workspaceId: string, ctx: PortContext): Promise<readonly RunSummary[]>;
  /** True while a CLI run is active in the workspace (the `@axis/git-ops` guard and the worktrees refusals). */
  isActive(workspaceId: string): boolean;
}
