/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// The renderer side of the project actions (docs/design/project-registration-and-trust.md §4.1 and §7, ticket S3). The renderer
// only ASKS: it sends main `{ nonce, action }` and nothing else (no path, no project id), main takes the folder from this window,
// shows its own dialog and decides. What comes back is a closed outcome; what the user hears is a sentence from the closed table
// below, never text from main or the daemon. Pure: the IPC lives in electron-browser/, the views in contrib/.

import { AxisDaemonStatus, isUsable } from '../../daemon/common/axisDaemonClient.js';
import { localize } from '../../../../nls.js';
import { AXIS_ID_PATTERN, type IAxisProjectInfo } from '../../workspaces/common/axisWorkspaceData.js';

/** What the user can ask for (the commands and the banner button). */
export const AXIS_PROJECT_ACTIONS = ['add', 'trust', 'untrust'] as const;
export type AxisProjectAction = (typeof AXIS_PROJECT_ACTIONS)[number];
/** Everything the renderer may send: the actions plus `status`, main's read of this window's folder (no dialog, changes nothing). */
export const AXIS_PROJECT_REQUESTS = [...AXIS_PROJECT_ACTIONS, 'status'] as const;
export type AxisProjectRequest = (typeof AXIS_PROJECT_REQUESTS)[number];

/** Main's closed outcomes (`PROJECT_OUTCOMES` in packages/daemon-host/src/main/project-actions.ts). */
export const AXIS_PROJECT_OUTCOMES = ['added', 'added_read_only', 'trusted', 'untrusted', 'cancelled', 'expired', 'no_folder', 'not_a_repository', 'refused', 'busy', 'unavailable', 'status_trusted', 'status_read_only', 'status_not_registered'] as const;
export type AxisProjectOutcome = (typeof AXIS_PROJECT_OUTCOMES)[number];

export const AXIS_PROJECT_REQUEST_CHANNEL = 'vscode:axisProjectAction';
export const AXIS_PROJECT_RESULT_CHANNEL = 'vscode:axisProjectActionResult';
/** Main's dialog lives at most 60 s, its host requests 15 s each: past this the renderer stops waiting and reports unavailable. */
export const AXIS_PROJECT_CLIENT_TIMEOUT_MS = 90_000;

const NONCE = /^[A-Za-z0-9_-]{1,64}$/;

/** The one message the renderer may send: exactly `{ nonce, action }`, so no path or project id can ever ride along. */
export function projectActionRequest(nonce: string, action: AxisProjectRequest): { readonly nonce: string; readonly action: AxisProjectRequest } {
	if (!NONCE.test(nonce) || !(AXIS_PROJECT_REQUESTS as readonly string[]).includes(action)) {
		throw new Error('invalid project action request');
	}
	return Object.freeze({ nonce, action });
}

/** Any value from main read as a closed outcome: anything else is `unavailable`. */
export function toOutcome(value: unknown): AxisProjectOutcome {
	return typeof value === 'string' && (AXIS_PROJECT_OUTCOMES as readonly string[]).includes(value) ? value as AxisProjectOutcome : 'unavailable';
}

/** The sentence the polite status region announces for an outcome: from this closed table only. */
export function outcomeSentence(outcome: AxisProjectOutcome): string {
	switch (outcome) {
		case 'added': return localize('axis.project.outcome.added', "Added the repository. It is trusted to run.");
		case 'added_read_only': return localize('axis.project.outcome.addedReadOnly', "Added the repository read only.");
		case 'trusted': return localize('axis.project.outcome.trusted', "The repository is trusted to run.");
		case 'untrusted': return localize('axis.project.outcome.untrusted', "The repository is read only now. Its runs were stopped.");
		case 'cancelled': return localize('axis.project.outcome.cancelled', "Cancelled. Nothing changed.");
		case 'expired': return localize('axis.project.outcome.expired', "The confirmation timed out. Nothing changed.");
		case 'no_folder': return localize('axis.project.outcome.noFolder', "Open a single repository folder in this window first.");
		case 'not_a_repository': return localize('axis.project.outcome.notRepo', "Open the repository's top folder to add it.");
		case 'refused': return localize('axis.project.outcome.refused', "That cannot be done for this folder now.");
		case 'busy': return localize('axis.project.outcome.busy', "Another project action is in progress, or one was just cancelled. Try again in a minute.");
		case 'unavailable': return localize('axis.project.outcome.unavailable', "The Axis service is not available. Nothing changed.");
		case 'status_trusted': return localize('axis.project.outcome.statusTrusted', "This folder is trusted to run.");
		case 'status_read_only': return localize('axis.project.outcome.statusReadOnly', "This folder is read only.");
		case 'status_not_registered': return localize('axis.project.outcome.statusNotRegistered', "This folder is not an Axis project yet.");
	}
}

/** This window's folder as main last read it (`status`); `unknown` for anything but the three status outcomes. */
export type AxisWindowRunTrust = 'trusted' | 'read_only' | 'not_registered' | 'unknown';

export function toWindowRunTrust(outcome: AxisProjectOutcome): AxisWindowRunTrust {
	switch (outcome) {
		case 'status_trusted': return 'trusted';
		case 'status_read_only': return 'read_only';
		case 'status_not_registered': return 'not_registered';
		default: return 'unknown';
	}
}

/**
 * Where the shown projects come from, which decides what may be said about run trust:
 * - `daemon`: connected, and the projects are the daemon's records: run trust is known.
 * - `unregistered`: connected, but the daemon holds no project, so the rows come from local discovery: none is an Axis project.
 * - `offline`: the daemon is not usable: run trust is unknown and no action is offered.
 * - `degraded`: the host is degraded (its audit status says so, PV-E0 F2): it serves reads but writes nothing, so run trust is not
 *   shown and no action is offered either.
 * Local discovery's trust flag is Code OSS Workspace Trust, not the run-trust record, so it is never shown as "trusted to run".
 */
export type AxisTrustSource = 'daemon' | 'unregistered' | 'offline' | 'degraded';

export function trustSource(status: AxisDaemonStatus, origin: 'daemon' | 'discovery'): AxisTrustSource {
	return status.kind === 'degraded' ? 'degraded' : !isUsable(status) ? 'offline' : origin === 'daemon' ? 'daemon' : 'unregistered';
}

/** The longest project name shown inline; the full name is in the tooltip. */
export const AXIS_MAX_INLINE_NAME = 40;
/** The longest name a tooltip shows (review N4). */
export const AXIS_MAX_TOOLTIP_NAME = 200;

/** The name with control and format characters removed: for a tooltip, which shows it whole. */
export function plainName(name: string): string {
	const clean = [...name.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '')];
	if (clean.length === 0) {
		return localize('axis.project.unnamed', "(unnamed)");
	}
	return clean.length > AXIS_MAX_TOOLTIP_NAME ? clean.slice(0, AXIS_MAX_TOOLTIP_NAME - 1).join('') + '\u2026' : clean.join('');
}

/**
 * A project name as it sits inside a sentence: control and format characters removed (a name cannot reorder the text around it),
 * cut to `AXIS_MAX_INLINE_NAME` with an ellipsis, and wrapped in a first-strong isolate (U+2068 ... U+2069). So a right-to-left name
 * keeps its own order and the sentence keeps the UI's direction and its words.
 */
export function isolateName(name: string): string {
	const clean = [...plainName(name)];
	const shown = clean.length > AXIS_MAX_INLINE_NAME ? clean.slice(0, AXIS_MAX_INLINE_NAME - 1).join('') + '\u2026' : clean.join('');
	return `\u2068${shown}\u2069`;
}

/** The chip text for a project: glyph AND words, never colour alone. Unknown trust says so. */
export function projectChip(project: IAxisProjectInfo, source: AxisTrustSource): { readonly glyph: string; readonly label: string; readonly hint: string } {
	if (source === 'unregistered') {
		return { glyph: '+', label: localize('axis.project.chip.unregistered', "{0}: not added to Axis", isolateName(project.name)), hint: localize('axis.project.chip.unregisteredHint', "Add Project… makes it an Axis project. It starts read only until you trust it to run.") };
	}
	if (source === 'degraded') {
		return { glyph: '?', label: localize('axis.project.chip.unknown', "{0}: run trust unknown", isolateName(project.name)), hint: localize('axis.project.chip.degradedHint', "The Axis service is in degraded mode, so run trust cannot be shown.") };
	}
	if (source === 'offline') {
		return { glyph: '?', label: localize('axis.project.chip.unknown', "{0}: run trust unknown", isolateName(project.name)), hint: localize('axis.project.chip.unknownHint', "The Axis service is not connected, so run trust cannot be shown.") };
	}
	return project.trusted
		? { glyph: '\u2713', label: localize('axis.project.chip.trusted', "{0}: trusted to run", isolateName(project.name)), hint: localize('axis.project.chip.trustedHint', "CLI and agent runs, commits and pushes are allowed.") }
		: { glyph: '\u2298', label: localize('axis.project.chip.readOnly', "{0}: read only", isolateName(project.name)), hint: localize('axis.project.chip.readOnlyHint', "Runs, commits and pushes need Trust to run. If the repository changed, review and trust it again.") };
}

/** What the client needs from the IPC (the electron-browser adapter passes the preload's `ipcRenderer`). */
export interface IAxisProjectTransport {
	send(channel: string, payload: unknown): void;
	/** Listen for main's answers; returns the unsubscribe. */
	on(channel: string, listener: (payload: unknown) => void): () => void;
}

/** Main's answer as the renderer keeps it: the closed outcome, and (status of a registered folder only) its project id. */
export interface IAxisProjectAnswer {
	readonly outcome: AxisProjectOutcome;
	readonly projectId?: string;
}

const ANSWER_KEYS: ReadonlySet<string> = new Set(['nonce', 'outcome', 'projectId']);

/**
 * Read main's answer strictly (PV-D1-0): no key beyond nonce, outcome and projectId; a projectId only on `status_trusted` or
 * `status_read_only` and only in the journal id shape. Anything else is `unavailable`, never a partial answer.
 */
export function toAnswer(payload: object): IAxisProjectAnswer {
	if (Object.keys(payload).some(k => !ANSWER_KEYS.has(k))) {
		return { outcome: 'unavailable' };
	}
	const { outcome, projectId } = payload as { outcome?: unknown; projectId?: unknown };
	const closed = toOutcome(outcome);
	if (projectId === undefined) {
		return { outcome: closed };
	}
	const registered = closed === 'status_trusted' || closed === 'status_read_only';
	return registered && typeof projectId === 'string' && AXIS_ID_PATTERN.test(projectId) ? { outcome: closed, projectId } : { outcome: 'unavailable' };
}

/**
 * One request at a time is enough for the UI, but answers are matched by nonce anyway, so a late or foreign answer never settles
 * the wrong call. A call that gets no answer within the bound is `unavailable`.
 */
export class AxisProjectActionClient {
	private readonly pending = new Map<string, (answer: IAxisProjectAnswer) => void>();
	private readonly off: () => void;
	private seq = 0;

	constructor(private readonly transport: IAxisProjectTransport, private readonly randomId: () => string, private readonly timeoutMs = AXIS_PROJECT_CLIENT_TIMEOUT_MS) {
		this.off = transport.on(AXIS_PROJECT_RESULT_CHANNEL, payload => this.onResult(payload));
	}

	run(action: AxisProjectRequest): Promise<AxisProjectOutcome> {
		return this.ask(action).then(a => a.outcome);
	}

	/** `status` with its project id (this window's registered project, if any). */
	status(): Promise<IAxisProjectAnswer> {
		return this.ask('status');
	}

	private ask(action: AxisProjectRequest): Promise<IAxisProjectAnswer> {
		const nonce = `pa${++this.seq}${this.randomId().replace(/[^A-Za-z0-9]/g, '').slice(0, 32)}`;
		return new Promise(resolve => {
			const timer = setTimeout(() => settle({ outcome: 'unavailable' }), this.timeoutMs);
			const settle = (answer: IAxisProjectAnswer) => {
				clearTimeout(timer);
				this.pending.delete(nonce);
				resolve(answer);
			};
			this.pending.set(nonce, settle);
			try {
				this.transport.send(AXIS_PROJECT_REQUEST_CHANNEL, projectActionRequest(nonce, action));
			} catch {
				settle({ outcome: 'unavailable' });
			}
		});
	}

	dispose(): void {
		this.off();
		for (const settle of [...this.pending.values()]) {
			settle({ outcome: 'unavailable' });
		}
	}

	private onResult(payload: unknown): void {
		if (typeof payload !== 'object' || payload === null) {
			return;
		}
		const { nonce } = payload as { nonce?: unknown };
		const settle = typeof nonce === 'string' ? this.pending.get(nonce) : undefined;
		settle?.(toAnswer(payload));
	}
}

export interface IAxisBannerContent {
	readonly text: string;
	/** The one action offered, if any. */
	readonly action: { readonly id: AxisProjectAction; readonly label: string } | undefined;
}

/**
 * What the dashboard banner (contrib/projects/browser/axisProjectBanner.ts) says and offers. `trust` is main's `status` answer for
 * THIS window's folder; it counts only while the daemon is usable, so an offline service is always unknown with no action.
 */
export function bannerContent(trust: AxisWindowRunTrust, source: AxisTrustSource): IAxisBannerContent {
	if (source === 'degraded') {
		return { text: localize('axis.banner.degraded', "The Axis service is read only (degraded): projects cannot be added or trusted."), action: undefined };
	}
	if (source === 'offline') {
		return { text: localize('axis.banner.unknown', "Run trust unknown: the Axis service is not connected."), action: undefined };
	}
	// With discovery rows (the daemon holds no project) only "not registered" can be current: a trust answer is stale (review N3).
	switch (source === 'unregistered' && trust !== 'not_registered' ? 'unknown' : trust) {
		case 'not_registered':
			return { text: localize('axis.banner.none', "This folder is not an Axis project yet."), action: { id: 'add', label: localize('axis.banner.add', "Add Project…") } };
		case 'read_only':
			return { text: localize('axis.banner.readOnly', "This folder is read only: runs, commits and pushes need Trust to run."), action: { id: 'trust', label: localize('axis.banner.trust', "Trust to Run…") } };
		case 'trusted':
			return { text: localize('axis.banner.trusted', "This folder is trusted to run."), action: { id: 'untrust', label: localize('axis.banner.untrust', "Stop Trusting") } };
		case 'unknown':
			return { text: localize('axis.banner.statusUnknown', "Run trust for this folder is not known right now."), action: undefined };
	}
}
