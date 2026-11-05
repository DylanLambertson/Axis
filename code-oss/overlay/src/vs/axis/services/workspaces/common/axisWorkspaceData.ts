/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';

/*
 * Renderer copies of the daemon contract shapes (packages/protocol on
 * origin/feat/protocol-contracts-p1: `axis.projects/1` ProjectInfo,
 * `axis.worktrees/1` WorktreeInfo, `axis.cli-runs/1` CliRun). The Code OSS
 * tree cannot import `@axis/protocol` until the staging work (ADR 0005 D3)
 * lands, so the fields are copied here, field for field, and a data source
 * returns exactly what the daemon's `list` replies will carry. Phase 1 (task
 * B5) swaps the Phase 0 source for a bridge client without changing the views.
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

/** Where the data came from, shown to the user so sample data is never mistaken for real state. */
export type AxisDataProvenance = 'discovery' | 'sample';

/**
 * The read side of the daemon contracts the dashboard needs. The Phase 0
 * implementation reads git metadata from disk and, when asked, adds sample
 * runs; Phase 1 is a bridge client of the same three `list` methods.
 */
export interface IAxisWorkspaceDataSource {
	readonly onDidChange: Event<void>;
	/** `axis.projects/1.list` */
	listProjects(): Promise<readonly IAxisProjectInfo[]>;
	/** `axis.worktrees/1.list` */
	listWorktrees(projectId: string): Promise<readonly IAxisWorktreeInfo[]>;
	/** `axis.cli-runs/1.list`, one page (the Phase 0 source never pages). */
	listCliRuns(workspaceId?: string): Promise<readonly IAxisCliRun[]>;
	/** Provenance of the runs `listCliRuns` returns. */
	readonly runsProvenance: AxisDataProvenance;
}

/** Journal-id pattern of the contracts: `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. */
export const AXIS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
