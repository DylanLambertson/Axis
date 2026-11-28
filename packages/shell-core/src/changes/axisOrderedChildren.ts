// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Ported from the legacy overlay (services/changes/common/axisOrderedChildren.ts) by OS-5.

/** The part of a DOM parent `placeInOrder` uses, so it can be tested without a DOM. */
export interface IOrderedParent<T extends object> {
	readonly children: ArrayLike<object>;
	insertBefore(node: T, child: object | null): unknown;
	removeChild(child: object): unknown;
}

/**
 * Makes `parent`'s children exactly `children`, in order, with the fewest moves:
 * 1. children that are not wanted any more are removed first, so a removal before a kept
 *    element never makes that element move (moving a focused element blurs it, and a screen
 *    reader then announces it again);
 * 2. then each wanted child that is not already in its place is inserted there.
 * An element already in its place is never touched.
 */
export function placeInOrder<T extends object>(parent: IOrderedParent<T>, children: readonly T[]): void {
	const wanted = new Set<object>(children);
	for (const old of Array.from(parent.children)) {
		if (!wanted.has(old)) {
			parent.removeChild(old);
		}
	}
	children.forEach((child, i) => {
		if (parent.children[i] !== child) {
			parent.insertBefore(child, parent.children[i] ?? null);
		}
	});
}
