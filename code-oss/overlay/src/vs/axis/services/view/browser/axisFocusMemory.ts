/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { AxisViewKind } from '../../../common/axisView.js';

/** Upper bound on remembered focus targets; the oldest are dropped first. */
export const MAX_FOCUS_TARGETS = 256;

/**
 * The last focused element per workspace and view (docs/UX.md focus rules 1
 * and 2). Elements are held weakly and only reused while they are still in
 * the document and focusable, so a disposed widget never takes focus.
 */
export class AxisFocusMemory {

	private readonly targets = new Map<string, WeakRef<HTMLElement>>();

	private static key(workspaceId: string | undefined, view: AxisViewKind): string {
		return `${view}:${workspaceId ?? ''}`;
	}

	remember(workspaceId: string | undefined, view: AxisViewKind, element: HTMLElement | null | undefined): void {
		if (!element || !element.isConnected || element === element.ownerDocument.body) {
			return;
		}
		const key = AxisFocusMemory.key(workspaceId, view);
		this.targets.delete(key);
		this.targets.set(key, new WeakRef(element));
		while (this.targets.size > MAX_FOCUS_TARGETS) {
			const oldest = this.targets.keys().next();
			if (oldest.done) {
				break;
			}
			this.targets.delete(oldest.value);
		}
	}

	/** Focuses the remembered element. Returns false when there is none or it cannot take focus. */
	restore(workspaceId: string | undefined, view: AxisViewKind, accept: (element: HTMLElement) => boolean): boolean {
		const key = AxisFocusMemory.key(workspaceId, view);
		const element = this.targets.get(key)?.deref();
		if (!element || !element.isConnected || !accept(element)) {
			this.targets.delete(key);
			return false;
		}
		element.focus();
		return element.ownerDocument.activeElement === element;
	}

	clear(): void {
		this.targets.clear();
	}
}
