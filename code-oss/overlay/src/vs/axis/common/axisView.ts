/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/** The two Axis views of one window. Split mode is design task A6. */
export type AxisViewKind = 'agent' | 'ide';

export function isAxisViewKind(value: unknown): value is AxisViewKind {
	return value === 'agent' || value === 'ide';
}

/**
 * `axis.view.mode` (ADR 0004): whether each workspace remembers its own view
 * (`perWorkspace`) or one view applies to every workspace (`global`).
 */
export type AxisViewMode = 'perWorkspace' | 'global';

export const AXIS_VIEW_MODE_SETTING = 'axis.view.mode';

export const DEFAULT_AXIS_VIEW_MODE: AxisViewMode = 'perWorkspace';

/** Axis is agent-first: a workspace without a recorded view opens in the Agent view. */
export const DEFAULT_AXIS_VIEW: AxisViewKind = 'agent';

export function toAxisViewMode(value: unknown): AxisViewMode {
	return value === 'global' ? 'global' : DEFAULT_AXIS_VIEW_MODE;
}
