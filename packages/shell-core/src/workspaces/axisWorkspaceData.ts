// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Ported from the legacy overlay (services/workspaces/common/axisWorkspaceData.ts) by OS-5.

/*
 * Renderer copies of the daemon contract shapes (packages/protocol/src/{projects,worktrees,cliRuns}.ts: `axis.projects/1`
 * ProjectInfo, `axis.worktrees/1` WorktreeInfo, `axis.cli-runs/1` CliRun), field for field, as the legacy overlay kept
 * them. Replacing them with the `@axis/protocol` types is a later step; the shapes are what the daemon's replies carry.
 */

/** `axis.projects/1` ProjectInfo. */
export interface IAxisProjectInfo {
	readonly id: string;
	readonly name: string;
	readonly trusted: boolean;
}

export type AxisWorkspaceState = 'READY' | 'FINALISED' | 'CLEANED';

/** `axis.worktrees/1` WorktreeInfo. */
export interface IAxisWorktreeInfo {
	/** Journal id; absent for worktrees Axis did not create. */
	readonly id?: string;
	readonly origin: 'axis' | 'external';
	readonly projectId: string;
	readonly state?: AxisWorkspaceState;
	readonly branch: string | null;
	readonly baseRef?: string;
	/** Recorded at creation and never rewritten. */
	readonly baseSha?: string;
	readonly head: string | null;
	/** Absolute path, for display and opening only. Never sent back to the daemon. */
	readonly path: string;
	readonly locked: boolean;
	readonly present: boolean;
	readonly dirty?: { readonly staged: number; readonly unstaged: number; readonly untracked: number };
	readonly ahead?: number;
	readonly behind?: number;
}

export type AxisRunState = 'QUEUED' | 'RUNNING' | 'REVIEWING' | 'BLOCKED' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type AxisRunStatus = 'starting' | 'running' | 'quiet' | 'finished' | 'failed' | 'killed' | 'interrupted' | 'stopping';
export type AxisSnapshotAfter = 'pending' | 'ok' | 'drift' | 'unknown';

/** `axis.cli-runs/1` CliRun. */
export interface IAxisCliRun {
	readonly runId: string;
	readonly workspaceId: string;
	readonly agentId: string | null;
	readonly state: AxisRunState;
	readonly status: AxisRunStatus;
	readonly reason: string | null;
	readonly exitCode: number | null;
	readonly createdAt: string;
	readonly startedAt: string | null;
	readonly endedAt: string | null;
	readonly live: boolean;
	readonly lastOutputAt: number | null;
	readonly outputChars: number;
	readonly droppedChars: number;
	readonly snapshotAfter: AxisSnapshotAfter;
}

/** Where run data came from, shown to the user so sample data is never mistaken for real state. */
export type AxisDataProvenance = 'daemon' | 'sample';

/** Journal-id pattern of the contracts: `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. */
export const AXIS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
