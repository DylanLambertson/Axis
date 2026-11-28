// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Ported from the legacy overlay (contrib/agent/common/axisFileTreeText.ts) by OS-5.

import { localize } from '../base/nls.js';
import { cleanDisplayText } from '../workspaces/displayText.js';

/** Longest file or folder name a Files tree row shows, in code points. */
export const MAX_TREE_NAME = 120;
/** Longest name in a row's hover title, in code points (the full name when it fits). */
export const MAX_TREE_TITLE = 255;

/** Everything a Files tree row shows of a name: the visible text, the accessible name and the hover title. */
export interface IAxisFileRowText {
	readonly name: string;
	readonly label: string;
	readonly title: string;
}

/**
 * The text of a Files tree row. A file name comes from the worktree, which an agent writes,
 * so it is treated as hostile: every surface gets `cleanDisplayText` (control, bidi and
 * zero-width characters and letters that draw nothing become U+FFFD; a right-to-left
 * override can no longer turn `invoice‮fdp.exe` into "invoiceexe.pdf") and is clamped.
 * The row still opens the real file: only the text is cleaned.
 */
export function fileRowText(name: string, isDirectory: boolean): IAxisFileRowText {
	const shown = cleanDisplayText(name, MAX_TREE_NAME);
	return {
		name: shown,
		label: isDirectory ? localize('axis.files.folder', "{0}, folder", shown) : shown,
		title: cleanDisplayText(name, MAX_TREE_TITLE),
	};
}
