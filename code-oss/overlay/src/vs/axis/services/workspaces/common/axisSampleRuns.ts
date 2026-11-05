/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { IAxisCliRun } from './axisWorkspaceData.js';

/**
 * `axis.preview.sampleRuns`: shows a fixed set of sample CLI runs on the
 * dashboard, so the run columns can be seen before the daemon exists. The
 * dashboard labels them as sample data. Off by default.
 */
export const AXIS_SAMPLE_RUNS_SETTING = 'axis.preview.sampleRuns';

/** The agent id used by sample runs. It names no real CLI. */
export const SAMPLE_AGENT_ID = 'sample-cli';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/**
 * Deterministic sample runs, one per workspace for the first four workspaces,
 * covering the dashboard states: running, quiet (may be waiting for input),
 * failed and finished. Every record is valid against `axis.cli-runs/1` CliRun.
 */
export function sampleCliRuns(workspaceIds: readonly string[], now: number): IAxisCliRun[] {
	const iso = (offset: number) => new Date(now - offset).toISOString();
	const base = (workspaceId: string, index: number) => ({
		runId: `sample-${index + 1}`,
		workspaceId,
		agentId: SAMPLE_AGENT_ID,
		reason: null,
		createdAt: iso(30 * MINUTE),
		startedAt: iso(29 * MINUTE),
		droppedChars: 0,
	});

	const shapes: ((workspaceId: string, index: number) => IAxisCliRun)[] = [
		(id, i) => ({ ...base(id, i), state: 'RUNNING', status: 'running', exitCode: null, endedAt: null, live: true, lastOutputAt: now - 2 * SECOND, outputChars: 18_250, snapshotAfter: 'pending' }),
		(id, i) => ({ ...base(id, i), state: 'RUNNING', status: 'quiet', exitCode: null, endedAt: null, live: true, lastOutputAt: now - 4 * MINUTE, outputChars: 6_400, snapshotAfter: 'pending' }),
		(id, i) => ({ ...base(id, i), state: 'FAILED', status: 'failed', exitCode: 1, endedAt: iso(3 * MINUTE), live: false, lastOutputAt: now - 3 * MINUTE, outputChars: 2_048, snapshotAfter: 'ok' }),
		(id, i) => ({ ...base(id, i), state: 'COMPLETED', status: 'finished', exitCode: 0, endedAt: iso(10 * MINUTE), live: false, lastOutputAt: now - 10 * MINUTE, outputChars: 40_960, snapshotAfter: 'ok' }),
	];

	return workspaceIds.slice(0, shapes.length).map((id, index) => shapes[index](id, index));
}
