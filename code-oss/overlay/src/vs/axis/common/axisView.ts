/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/** The two Axis views of one window (ADR 0004 decision 4). */
export type AxisViewKind = 'agent' | 'ide';

export function isAxisViewKind(value: unknown): value is AxisViewKind {
	return value === 'agent' || value === 'ide';
}

/**
 * `axis.view.mode` (ADR 0004 decision 4):
 * - `perWorkspace`: each workspace remembers whether it shows the Agent or the IDE view;
 * - `global`: one view for every workspace;
 * - `split`: both views side by side.
 */
export type AxisViewMode = 'perWorkspace' | 'global' | 'split';

export const AXIS_VIEW_MODES: readonly AxisViewMode[] = ['perWorkspace', 'global', 'split'];

export const AXIS_VIEW_MODE_SETTING = 'axis.view.mode';

export const DEFAULT_AXIS_VIEW_MODE: AxisViewMode = 'perWorkspace';

/** Axis is agent-first: a workspace without a recorded view opens in the Agent view. */
export const DEFAULT_AXIS_VIEW: AxisViewKind = 'agent';

export function toAxisViewMode(value: unknown): AxisViewMode {
	return value === 'global' || value === 'split' ? value : DEFAULT_AXIS_VIEW_MODE;
}

/** Which half of the split is collapsed to its header (docs/UX.md, split mode). */
export type AxisSplitCollapse = 'none' | 'agent' | 'ide';

export function toAxisSplitCollapse(value: unknown): AxisSplitCollapse {
	return value === 'agent' || value === 'ide' ? value : 'none';
}

/** What the workbench layout shows: one view, or both side by side. */
export type AxisLayoutKind = AxisViewKind | 'split';

export interface IAxisLayoutRequest {
	readonly kind: AxisLayoutKind;
	/** Only meaningful for `split`. */
	readonly collapsed: AxisSplitCollapse;
}

export function sameLayoutRequest(a: IAxisLayoutRequest | undefined, b: IAxisLayoutRequest): boolean {
	return !!a && a.kind === b.kind && (a.kind !== 'split' || a.collapsed === b.collapsed);
}
