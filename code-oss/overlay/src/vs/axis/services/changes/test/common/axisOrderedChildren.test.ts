/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IOrderedParent, placeInOrder } from '../../common/axisOrderedChildren.js';

interface INode { readonly name: string }

/** A parent that records every move and removal, as the DOM would see them. */
class FakeParent implements IOrderedParent<INode> {
	readonly children: INode[];
	readonly ops: string[] = [];

	constructor(...names: string[]) {
		this.children = names.map(name => node(name));
	}

	insertBefore(child: INode, before: object | null): void {
		const from = this.children.indexOf(child);
		if (from >= 0) {
			this.children.splice(from, 1);
		}
		const at = before ? this.children.indexOf(before as INode) : this.children.length;
		this.children.splice(at, 0, child);
		this.ops.push(`move ${child.name}`);
	}

	removeChild(child: object): void {
		this.children.splice(this.children.indexOf(child as INode), 1);
		this.ops.push(`remove ${(child as INode).name}`);
	}

	get(name: string): INode {
		return this.children.find(c => c.name === name)!;
	}

	names(): string[] {
		return this.children.map(c => c.name);
	}
}

const nodes = new Map<string, INode>();
function node(name: string): INode {
	let n = nodes.get(name);
	if (!n) {
		n = { name };
		nodes.set(name, n);
	}
	return n;
}

suite('Axis Changes in-place update (placeInOrder)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('removing children above a kept one never moves it (a focused row is not blurred)', () => {
		const parent = new FakeParent('readme', 'a', 'b', 'c');
		placeInOrder(parent, [parent.get('b'), parent.get('c')]);
		assert.deepStrictEqual(parent.names(), ['b', 'c']);
		assert.deepStrictEqual(parent.ops, ['remove readme', 'remove a'], 'b and c are never moved');
	});

	test('children no longer wanted are removed, wherever they are', () => {
		const parent = new FakeParent('a', 'x', 'b', 'y');
		placeInOrder(parent, [parent.get('a'), parent.get('b')]);
		assert.deepStrictEqual(parent.names(), ['a', 'b']);
		placeInOrder(parent, []);
		assert.deepStrictEqual(parent.names(), []);
	});

	test('an unchanged list is not touched; new children go in their place', () => {
		const parent = new FakeParent('a', 'b');
		placeInOrder(parent, [parent.get('a'), parent.get('b')]);
		assert.deepStrictEqual(parent.ops, []);
		placeInOrder(parent, [node('n0'), parent.get('a'), node('n1'), parent.get('b'), node('n2')]);
		assert.deepStrictEqual(parent.names(), ['n0', 'a', 'n1', 'b', 'n2']);
		assert.deepStrictEqual(parent.ops, ['move n0', 'move n1', 'move n2'], 'only the new children are inserted');
	});

	test('a reorder moves only what has to move', () => {
		const parent = new FakeParent('a', 'b', 'c');
		placeInOrder(parent, [parent.get('c'), parent.get('a'), parent.get('b')]);
		assert.deepStrictEqual(parent.names(), ['c', 'a', 'b']);
		assert.deepStrictEqual(parent.ops, ['move c']);
	});
});
