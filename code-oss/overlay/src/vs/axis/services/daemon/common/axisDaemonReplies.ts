/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { AXIS_ID_PATTERN, IAxisCliRun, IAxisProjectInfo, IAxisWorktreeInfo } from '../../workspaces/common/axisWorkspaceData.js';
import { cleanDisplayText } from '../../workspaces/common/worktreeDiscovery.js';
import { IAxisApprovalCard, IAxisApprovalResolveReply } from '../../approvals/common/axisApprovals.js';
import { AxisDaemonCallError } from './axisDaemonClient.js';

/*
 * Validators for daemon replies (docs/design/axis-shell-a2.md, "Data flow"):
 * the renderer copies of the strict schemas in packages/protocol/src/
 * {projects,worktrees,cliRuns,approvals}.ts. A reply that is not exactly the
 * contract shape is dropped whole (`invalid_reply`); a value is never echoed.
 */

export const MAX_PROJECTS = 1000;
export const MAX_WORKTREES = 1000;
export const MAX_STATUS_IDS = 100;
export const MAX_CLI_RUNS = 500;
export const MAX_PENDING_CHALLENGES = 1024;

const MAX_PATH = 4096;
const MAX_REF = 256;
const MAX_NAME = 80;
const SHA = /^[0-9a-f]{40,64}$/;
const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/;
const TIMESTAMP_MAX = 64;
const RUN_STATES = ['QUEUED', 'RUNNING', 'REVIEWING', 'BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED'];
const RUN_STATUSES = ['starting', 'running', 'quiet', 'finished', 'failed', 'killed', 'interrupted', 'stopping'];
const SNAPSHOTS = ['pending', 'ok', 'drift', 'unknown'];
const WORKSPACE_STATES = ['READY', 'FINALISED', 'CLEANED'];
/** Control, format (bidi, zero-width) and line-separator characters, NUL included. */
const UNSAFE_PATH_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
/** POSIX absolute, a drive path, or a UNC path. */
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/]|\\\\)/;
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

function invalid(): never {
	throw new AxisDaemonCallError('invalid_reply');
}

type Record_ = Readonly<Record<string, unknown>>;

/** A plain object whose own keys are all in `allowed` and include every key of `required`. */
function record(value: unknown, allowed: readonly string[], required: readonly string[]): Record_ {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return invalid();
	}
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) {
		return invalid();
	}
	const keys = Object.keys(value);
	if (keys.some(key => !allowed.includes(key)) || required.some(key => !keys.includes(key))) {
		return invalid();
	}
	return value as Record_;
}

function array(value: unknown, max: number): readonly unknown[] {
	return Array.isArray(value) && value.length <= max ? value : invalid();
}

function id(value: unknown): string {
	return typeof value === 'string' && AXIS_ID_PATTERN.test(value) ? value : invalid();
}

function text(value: unknown, max: number): string {
	return typeof value === 'string' && value.length <= max ? value : invalid();
}

/** A worktree path: used as a terminal cwd and a file tree root, so it must be absolute and free of control characters. */
function absolutePath(value: unknown): string {
	const path = text(value, MAX_PATH);
	return ABSOLUTE_PATH.test(path) && !UNSAFE_PATH_CHARS.test(path) ? path : invalid();
}

function bool(value: unknown): boolean {
	return typeof value === 'boolean' ? value : invalid();
}

function count(value: unknown): number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
}

function oneOf<T extends string>(value: unknown, set: readonly T[]): T {
	return typeof value === 'string' && (set as readonly string[]).includes(value) ? value as T : invalid();
}

function nullable<T>(value: unknown, read: (v: unknown) => T): T | null {
	return value === null ? null : read(value);
}

function noDuplicates(ids: readonly string[]): void {
	if (new Set(ids).size !== ids.length) {
		invalid();
	}
}

/** `axis.projects/1.list` reply. */
export function readProjects(reply: unknown): IAxisProjectInfo[] {
	const projects = array(record(reply, ['projects'], ['projects']).projects, MAX_PROJECTS).map(item => {
		const p = record(item, ['id', 'name', 'trusted'], ['id', 'name', 'trusted']);
		return { id: id(p.id), name: cleanDisplayText(text(p.name, MAX_NAME), MAX_NAME), trusted: bool(p.trusted) };
	});
	noDuplicates(projects.map(p => p.id));
	return projects;
}

function readWorktree(item: unknown): IAxisWorktreeInfo {
	const w = record(item,
		['id', 'origin', 'projectId', 'state', 'branch', 'baseRef', 'baseSha', 'head', 'path', 'locked', 'present', 'dirty', 'ahead', 'behind'],
		['origin', 'projectId', 'branch', 'head', 'path', 'locked', 'present']);
	const dirty = w.dirty === undefined ? undefined : record(w.dirty, ['staged', 'unstaged', 'untracked'], ['staged', 'unstaged', 'untracked']);
	return {
		...(w.id !== undefined && { id: id(w.id) }),
		origin: oneOf(w.origin, ['axis', 'external'] as const),
		projectId: id(w.projectId),
		...(w.state !== undefined && { state: oneOf(w.state, WORKSPACE_STATES as ('READY' | 'FINALISED' | 'CLEANED')[]) }),
		branch: nullable(w.branch, v => cleanDisplayText(text(v, MAX_REF), MAX_REF)),
		...(w.baseRef !== undefined && { baseRef: cleanDisplayText(text(w.baseRef, MAX_REF), MAX_REF) }),
		...(w.baseSha !== undefined && { baseSha: typeof w.baseSha === 'string' && SHA.test(w.baseSha) ? w.baseSha : invalid() }),
		head: nullable(w.head, v => typeof v === 'string' && SHA.test(v) ? v : invalid()),
		path: absolutePath(w.path),
		locked: bool(w.locked),
		present: bool(w.present),
		...(dirty && { dirty: { staged: count(dirty.staged), unstaged: count(dirty.unstaged), untracked: count(dirty.untracked) } }),
		...(w.ahead !== undefined && { ahead: count(w.ahead) }),
		...(w.behind !== undefined && { behind: count(w.behind) }),
	};
}

/** `axis.worktrees/1.list` reply (at most `max` worktrees, 1000 by default) and `status` reply (`max` = 100). */
export function readWorktrees(reply: unknown, max: number = MAX_WORKTREES): IAxisWorktreeInfo[] {
	const worktrees = array(record(reply, ['worktrees'], ['worktrees']).worktrees, max).map(readWorktree);
	// One workspace key per row: the journal id, else the path (ids and paths of id-less rows are told apart by prefix).
	noDuplicates(worktrees.map(w => w.id !== undefined ? `id:${w.id}` : `path:${w.path}`));
	return worktrees;
}

function readRun(item: unknown): IAxisCliRun {
	const r = record(item,
		['runId', 'workspaceId', 'agentId', 'state', 'status', 'reason', 'exitCode', 'createdAt', 'startedAt', 'endedAt', 'live', 'lastOutputAt', 'outputChars', 'droppedChars', 'snapshotAfter'],
		['runId', 'workspaceId', 'agentId', 'state', 'status', 'reason', 'exitCode', 'createdAt', 'startedAt', 'endedAt', 'live', 'lastOutputAt', 'outputChars', 'droppedChars', 'snapshotAfter']);
	const state = oneOf(r.state, RUN_STATES as IAxisCliRun['state'][]);
	const startedAt = nullable(r.startedAt, v => text(v, TIMESTAMP_MAX));
	const endedAt = nullable(r.endedAt, v => text(v, TIMESTAMP_MAX));
	if ((endedAt !== null) !== TERMINAL.has(state) || (startedAt === null && state !== 'QUEUED' && state !== 'CANCELLED')) {
		invalid();
	}
	return {
		runId: id(r.runId),
		workspaceId: id(r.workspaceId),
		agentId: nullable(r.agentId, v => typeof v === 'string' && AGENT_ID.test(v) ? v : invalid()),
		state,
		status: oneOf(r.status, RUN_STATUSES as IAxisCliRun['status'][]),
		reason: nullable(r.reason, v => typeof v === 'string' && REASON.test(v) ? v : invalid()),
		exitCode: nullable(r.exitCode, v => typeof v === 'number' && Number.isInteger(v) && v >= -255 && v <= 255 ? v : invalid()),
		createdAt: text(r.createdAt, TIMESTAMP_MAX),
		startedAt,
		endedAt,
		live: bool(r.live),
		lastOutputAt: nullable(r.lastOutputAt, count),
		outputChars: count(r.outputChars),
		droppedChars: count(r.droppedChars),
		snapshotAfter: oneOf(r.snapshotAfter, SNAPSHOTS as IAxisCliRun['snapshotAfter'][]),
	};
}

/** `axis.cli-runs/1.list` reply. */
export function readCliRuns(reply: unknown): IAxisCliRun[] {
	const runs = array(record(reply, ['runs'], ['runs']).runs, MAX_CLI_RUNS).map(readRun);
	noDuplicates(runs.map(run => run.runId));
	return runs;
}

const CHALLENGE_ID = /^[A-Za-z0-9_-]{22,64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const CONTRACT_NAME = /^[a-z][a-z0-9.-]{0,63}$/;
const METHOD_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
/** The longest `targetSummary` a listing carries (`MAX_LISTED_SUMMARY` in `@axis/protocol`). */
export const MAX_LISTED_SUMMARY = 192;
/** The largest epoch value a `Date` can show. */
const MAX_DATE_MS = 8.64e15;

function match(value: unknown, pattern: RegExp): string {
	return typeof value === 'string' && pattern.test(value) ? value : invalid();
}

/** `axis.approvals/1.pending` reply: the exact listed-challenge shape, the summary cleaned for display. */
export function readPendingChallenges(reply: unknown): IAxisApprovalCard[] {
	const keys = ['challengeId', 'digest', 'contract', 'method', 'tier', 'targetSummary', 'nativeConfirmationRequired', 'expiresAt'];
	const cards = array(record(reply, ['challenges'], ['challenges']).challenges, MAX_PENDING_CHALLENGES).map(item => {
		const c = record(item, keys, keys);
		const tier = count(c.tier);
		if (tier > 5 || typeof c.expiresAt !== 'number' || !Number.isSafeInteger(c.expiresAt) || c.expiresAt <= 0 || c.expiresAt > MAX_DATE_MS) {
			return invalid();
		}
		return {
			challengeId: match(c.challengeId, CHALLENGE_ID),
			digest: match(c.digest, DIGEST),
			contract: match(c.contract, CONTRACT_NAME),
			method: match(c.method, METHOD_NAME),
			tier,
			targetSummary: cleanDisplayText(text(c.targetSummary, MAX_LISTED_SUMMARY), MAX_LISTED_SUMMARY),
			nativeConfirmationRequired: bool(c.nativeConfirmationRequired),
			expiresAt: c.expiresAt,
		};
	});
	noDuplicates(cards.map(c => c.challengeId));
	return cards;
}

/** `axis.approvals/1.resolve` reply. */
export function readResolveReply(reply: unknown): IAxisApprovalResolveReply {
	const r = record(reply, ['challengeId', 'state', 'nativeRequired'], ['challengeId', 'state', 'nativeRequired']);
	return {
		challengeId: match(r.challengeId, CHALLENGE_ID),
		state: oneOf(r.state, ['approved', 'denied', 'expired'] as const),
		nativeRequired: bool(r.nativeRequired),
	};
}
