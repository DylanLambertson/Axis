/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// The renderer side of the project actions (docs/design/project-registration-and-trust.md §4.1 and §7, ticket S3). The renderer
// only ASKS: it sends main `{ nonce, action }` and nothing else (no path, no project id), main takes the folder from this window,
// shows its own dialog and decides. What comes back is a closed outcome; what the user hears is a sentence from the closed table
// below, never text from main or the daemon. Pure: the IPC lives in electron-browser/, the views in contrib/.

import { localize } from '../../../../nls.js';
import type { IAxisProjectInfo } from '../../workspaces/common/axisWorkspaceData.js';

export const AXIS_PROJECT_ACTIONS = ['add', 'trust', 'untrust'] as const;
export type AxisProjectAction = (typeof AXIS_PROJECT_ACTIONS)[number];

/** Main's closed outcomes (`PROJECT_OUTCOMES` in packages/daemon-host/src/main/project-actions.ts). */
export const AXIS_PROJECT_OUTCOMES = ['added', 'added_read_only', 'trusted', 'untrusted', 'cancelled', 'expired', 'no_folder', 'not_a_repository', 'refused', 'busy', 'unavailable'] as const;
export type AxisProjectOutcome = (typeof AXIS_PROJECT_OUTCOMES)[number];

export const AXIS_PROJECT_REQUEST_CHANNEL = 'vscode:axisProjectAction';
export const AXIS_PROJECT_RESULT_CHANNEL = 'vscode:axisProjectActionResult';
/** Main's dialog lives at most 60 s, its host requests 15 s each: past this the renderer stops waiting and reports unavailable. */
export const AXIS_PROJECT_CLIENT_TIMEOUT_MS = 90_000;

const NONCE = /^[A-Za-z0-9_-]{1,64}$/;

/** The one message the renderer may send: exactly `{ nonce, action }`, so no path or project id can ever ride along. */
export function projectActionRequest(nonce: string, action: AxisProjectAction): { readonly nonce: string; readonly action: AxisProjectAction } {
	if (!NONCE.test(nonce) || !(AXIS_PROJECT_ACTIONS as readonly string[]).includes(action)) {
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
	}
}

/**
 * Where the shown projects come from, which decides what may be said about run trust:
 * - `daemon`: connected, and the projects are the daemon's records: run trust is known.
 * - `unregistered`: connected, but the daemon holds no project, so the rows come from local discovery: none is an Axis project.
 * - `offline`: the daemon is not usable: run trust is unknown and no action is offered.
 * Local discovery's trust flag is Code OSS Workspace Trust, not the run-trust record, so it is never shown as "trusted to run".
 */
export type AxisTrustSource = 'daemon' | 'unregistered' | 'offline';

export function trustSource(daemonUsable: boolean, origin: 'daemon' | 'discovery'): AxisTrustSource {
	return !daemonUsable ? 'offline' : origin === 'daemon' ? 'daemon' : 'unregistered';
}

/** This window's project as the views show it. `known` is true only when its record came from the daemon. */
export type AxisWindowProjectState =
	| { readonly kind: 'none' }
	| { readonly kind: 'registered'; readonly project: IAxisProjectInfo; readonly known: boolean };

/** The project whose local checkout row is this window's folder (the one the actions act on); `none` when there is no single one. */
export function windowProjectState(input: {
	readonly source: AxisTrustSource;
	readonly projects: readonly IAxisProjectInfo[];
	readonly localCheckoutProjectIds: readonly string[];
}): AxisWindowProjectState {
	if (input.source === 'unregistered') {
		return { kind: 'none' }; // a discovered folder the daemon does not hold is not an Axis project
	}
	const ids = [...new Set(input.localCheckoutProjectIds)];
	const project = ids.length === 1 ? input.projects.find(p => p.id === ids[0]) : undefined;
	return project === undefined ? { kind: 'none' } : { kind: 'registered', project, known: input.source === 'daemon' };
}

/**
 * The project ids of the local checkout rows that ARE this window's folder (exactly one open folder; a path match). Main acts on the
 * window's folder itself; this only decides where the dashboard offers the buttons.
 */
export function windowLocalCheckoutIds(
	entries: ReadonlyArray<{ readonly isLocalCheckout: boolean; readonly project: { readonly id: string }; readonly worktree: { readonly path: string } }>,
	folderPaths: readonly string[],
): string[] {
	if (folderPaths.length !== 1) {
		return [];
	}
	return entries.filter(e => e.isLocalCheckout && e.worktree.path === folderPaths[0]).map(e => e.project.id);
}

/** The longest project name shown inline; the full name is in the tooltip. */
export const AXIS_MAX_INLINE_NAME = 40;

/** The name with control and format characters removed: for a tooltip, which shows it whole. */
export function plainName(name: string): string {
	return name.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '');
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

/**
 * One request at a time is enough for the UI, but answers are matched by nonce anyway, so a late or foreign answer never settles
 * the wrong call. A call that gets no answer within the bound is `unavailable`.
 */
export class AxisProjectActionClient {
	private readonly pending = new Map<string, (outcome: AxisProjectOutcome) => void>();
	private readonly off: () => void;
	private seq = 0;

	constructor(private readonly transport: IAxisProjectTransport, private readonly randomId: () => string, private readonly timeoutMs = AXIS_PROJECT_CLIENT_TIMEOUT_MS) {
		this.off = transport.on(AXIS_PROJECT_RESULT_CHANNEL, payload => this.onResult(payload));
	}

	run(action: AxisProjectAction): Promise<AxisProjectOutcome> {
		const nonce = `pa${++this.seq}${this.randomId().replace(/[^A-Za-z0-9]/g, '').slice(0, 32)}`;
		return new Promise(resolve => {
			const timer = setTimeout(() => settle('unavailable'), this.timeoutMs);
			const settle = (outcome: AxisProjectOutcome) => {
				clearTimeout(timer);
				this.pending.delete(nonce);
				resolve(outcome);
			};
			this.pending.set(nonce, settle);
			try {
				this.transport.send(AXIS_PROJECT_REQUEST_CHANNEL, projectActionRequest(nonce, action));
			} catch {
				settle('unavailable');
			}
		});
	}

	dispose(): void {
		this.off();
		for (const settle of [...this.pending.values()]) {
			settle('unavailable');
		}
	}

	private onResult(payload: unknown): void {
		if (typeof payload !== 'object' || payload === null) {
			return;
		}
		const { nonce, outcome } = payload as { nonce?: unknown; outcome?: unknown };
		const settle = typeof nonce === 'string' ? this.pending.get(nonce) : undefined;
		settle?.(toOutcome(outcome));
	}
}

export interface IAxisBannerContent {
	readonly text: string;
	/** The one action offered, if any. */
	readonly action: { readonly id: AxisProjectAction; readonly label: string } | undefined;
}

/** What the dashboard banner (contrib/projects/browser/axisProjectBanner.ts) says and offers for the window's project state. */
export function bannerContent(state: AxisWindowProjectState, source: AxisTrustSource): IAxisBannerContent {
	if (source === 'offline') {
		return { text: localize('axis.banner.unknown', "Run trust unknown: the Axis service is not connected."), action: undefined };
	}
	if (source !== 'daemon' || state.kind === 'none' || !state.known) { // Trust and Stop only from daemon rows
		return { text: localize('axis.banner.none', "This folder is not an Axis project yet."), action: { id: 'add', label: localize('axis.banner.add', "Add Project…") } };
	}
	return state.project.trusted
		? { text: localize('axis.banner.trusted', "{0} is trusted to run.", isolateName(state.project.name)), action: { id: 'untrust', label: localize('axis.banner.untrust', "Stop Trusting") } }
		: { text: localize('axis.banner.readOnly', "{0} is read only: runs, commits and pushes need Trust to run.", isolateName(state.project.name)), action: { id: 'trust', label: localize('axis.banner.trust', "Trust to Run…") } };
}
