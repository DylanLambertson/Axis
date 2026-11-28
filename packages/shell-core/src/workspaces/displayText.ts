// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The display-text rules of the legacy overlay's worktreeDiscovery.ts, ported by OS-5. The git metadata parsers of
// that file are not ported: the own shell's renderer reads no files, and its rows come from the daemon only.

/** Control, format (bidi overrides, zero-width) and line-separator characters, as the protocol's name rule. */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
/** Private-use and unassigned code points: no meaning a reader can check. */
const OPAQUE_TEXT = /[\p{Co}\p{Cn}]/gu;
/** Letters and symbols that draw nothing (Hangul fillers, the blank Braille pattern, Khmer inherent vowels): a name made of them would look empty. */
const INVISIBLE_TEXT = /[\u115F\u1160\u17B4\u17B5\u2800\u3164\uFFA0]/gu;
/** A third and later combining mark in a row (stacked marks that spill over neighbouring text). */
const MARK_RUN = /(\p{M}{2})\p{M}+/gu;

/**
 * Text from outside the renderer (a daemon reply) made safe to show: control, format and bidi characters, unassigned
 * or private-use code points and letters that draw nothing become U+FFFD (visible, never reordering the row), runs of
 * combining marks are cut to two, and the result is cut to `max` code points.
 */
export function cleanDisplayText(value: string, max: number): string {
	return clampText(value.replace(UNSAFE_TEXT, '�').replace(OPAQUE_TEXT, '�').replace(INVISIBLE_TEXT, '�').replace(MARK_RUN, '$1'), max);
}

/** Cuts text to at most `max` code points, ending with an ellipsis when it was longer. */
export function clampText(value: string, max: number): string {
	const points = [...value];
	return points.length <= max ? value : points.slice(0, max - 1).join('') + '…';
}

/** A display name for a project or workspace that fits the contract's name rules. */
export function displayName(value: string): string {
	const cleaned = value.replace(UNSAFE_TEXT, '').replace(OPAQUE_TEXT, '�').replace(MARK_RUN, '$1').trim();
	return clampText(cleaned || 'unnamed', 80);
}

/**
 * The last segment of a path the daemon reported, for a row label: trailing separators are dropped, and both `/` and
 * `\` separate (the daemon may run on Windows). A path made only of separators reads as empty.
 */
export function lastPathSegment(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, '');
	return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
}
