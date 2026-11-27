/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// The renderer's side of main's project actions (S3, docs/design/project-registration-and-trust.md §4). The renderer sends only
// { nonce, action }: main takes the folder from the window and draws the dialog; this service keeps the one action in flight and
// the last outcome for the views. Web and browser builds register it with no client: every action is `unavailable`.

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { AxisProjectAction, AxisProjectOutcome, AxisProjectRequest, AxisWindowRunTrust, IAxisProjectAnswer, toWindowRunTrust } from './axisProjectActions.js';

export const IAxisProjectActionsService = createDecorator<IAxisProjectActionsService>('axisProjectActionsService');

export interface IAxisProjectActionsService {
	readonly _serviceBrand: undefined;
	/** The action waiting for the user in main's dialog, if any. */
	readonly waiting: AxisProjectAction | undefined;
	/** The last outcome, for the dashboard banner; cleared when a new action starts. */
	readonly lastOutcome: AxisProjectOutcome | undefined;
	/** Main's last `status` answer for this window's folder; `unknown` until one arrives or when main cannot tell. */
	readonly windowTrust: AxisWindowRunTrust;
	/** This window's registered project id from the same answer (PV-D1-0), or undefined: the project home shows only this one. */
	readonly windowProjectId: string | undefined;
	readonly onDidChange: Event<void>;
	/** One at a time: a second call while one waits answers `busy` without asking main. */
	run(action: AxisProjectAction): Promise<AxisProjectOutcome>;
	/** Ask main for `status` again (on a data change and after an action; never on a timer). One in flight; calls meanwhile coalesce. */
	refreshStatus(): void;
}

export interface IAxisProjectActionClient {
	run(action: AxisProjectRequest): Promise<AxisProjectOutcome>;
	status(): Promise<IAxisProjectAnswer>;
	dispose(): void;
}

export class AxisProjectActionsModel extends Disposable implements IAxisProjectActionsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private _waiting: AxisProjectAction | undefined;
	private _lastOutcome: AxisProjectOutcome | undefined;
	private _windowTrust: AxisWindowRunTrust = 'unknown';
	private _windowProjectId: string | undefined;
	private statusInFlight = false;
	private statusAgain = false;

	constructor(private readonly client: IAxisProjectActionClient | undefined) {
		super();
	}

	get waiting(): AxisProjectAction | undefined { return this._waiting; }
	get lastOutcome(): AxisProjectOutcome | undefined { return this._lastOutcome; }
	get windowTrust(): AxisWindowRunTrust { return this._windowTrust; }
	get windowProjectId(): string | undefined { return this._windowProjectId; }

	refreshStatus(): void {
		if (this.client === undefined || this._store.isDisposed) {
			return;
		}
		if (this.statusInFlight) {
			this.statusAgain = true;
			return;
		}
		this.statusInFlight = true;
		// A `busy` answer (the status rate limit) keeps the last answer instead of turning a known folder unknown (review N2).
		const keep = { trust: this._windowTrust, projectId: this._windowProjectId };
		this.client.status().then(
			a => a.outcome === 'busy' ? keep : { trust: toWindowRunTrust(a.outcome), projectId: a.projectId },
			() => ({ trust: 'unknown' as const, projectId: undefined }),
		).then(({ trust, projectId }) => {
			this.statusInFlight = false;
			if (this._store.isDisposed) {
				return;
			}
			// The id goes with a registered answer only; any other answer (unknown, not registered) clears it.
			const id = trust === 'trusted' || trust === 'read_only' ? projectId : undefined;
			if (trust !== this._windowTrust || id !== this._windowProjectId) {
				this._windowTrust = trust;
				this._windowProjectId = id;
				this._onDidChange.fire();
			}
			if (this.statusAgain) {
				this.statusAgain = false;
				this.refreshStatus();
			}
		});
	}

	async run(action: AxisProjectAction): Promise<AxisProjectOutcome> {
		if (this._waiting !== undefined) {
			return 'busy';
		}
		if (this.client === undefined || this._store.isDisposed) {
			return this.finish('unavailable');
		}
		this._waiting = action;
		this._lastOutcome = undefined;
		this._onDidChange.fire();
		let outcome: AxisProjectOutcome;
		try {
			outcome = await this.client.run(action);
		} catch {
			outcome = 'unavailable';
		}
		this._waiting = undefined;
		const done = this.finish(outcome);
		this.refreshStatus(); // the action may have changed this folder's record
		return done;
	}

	override dispose(): void {
		this.client?.dispose();
		super.dispose();
	}

	private finish(outcome: AxisProjectOutcome): AxisProjectOutcome {
		if (!this._store.isDisposed) {
			this._lastOutcome = outcome;
			this._onDidChange.fire();
		}
		return outcome;
	}
}
