/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// The renderer's side of main's project actions (S3, docs/design/project-registration-and-trust.md §4). The renderer sends only
// { nonce, action }: main takes the folder from the window and draws the dialog; this service keeps the one action in flight and
// the last outcome for the views. Web and browser builds register it with no client: every action is `unavailable`.

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { AxisProjectAction, AxisProjectOutcome } from './axisProjectActions.js';

export const IAxisProjectActionsService = createDecorator<IAxisProjectActionsService>('axisProjectActionsService');

export interface IAxisProjectActionsService {
	readonly _serviceBrand: undefined;
	/** The action waiting for the user in main's dialog, if any. */
	readonly waiting: AxisProjectAction | undefined;
	/** The last outcome, for the dashboard banner; cleared when a new action starts. */
	readonly lastOutcome: AxisProjectOutcome | undefined;
	readonly onDidChange: Event<void>;
	/** One at a time: a second call while one waits answers `busy` without asking main. */
	run(action: AxisProjectAction): Promise<AxisProjectOutcome>;
}

export interface IAxisProjectActionClient {
	run(action: AxisProjectAction): Promise<AxisProjectOutcome>;
	dispose(): void;
}

export class AxisProjectActionsModel extends Disposable implements IAxisProjectActionsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private _waiting: AxisProjectAction | undefined;
	private _lastOutcome: AxisProjectOutcome | undefined;

	constructor(private readonly client: IAxisProjectActionClient | undefined) {
		super();
	}

	get waiting(): AxisProjectAction | undefined { return this._waiting; }
	get lastOutcome(): AxisProjectOutcome | undefined { return this._lastOutcome; }

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
		return this.finish(outcome);
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
