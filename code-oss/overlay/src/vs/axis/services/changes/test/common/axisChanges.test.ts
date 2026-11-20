/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { changeGroupLabel, changeKindGlyph, changeKindLabel, changeRowLabel, changesSummary, flatRows, IAxisChangeRow, MAX_CHANGE_FOLDER, MAX_CHANGE_NAME, MAX_CHANGE_ROWS, readChanges, toGitUri } from '../../common/axisChanges.js';
import { change, file, ROOT, state } from './axisChangesFixtures.js';

/** What a row puts on screen and in its accessible name, in DOM order. */
function shown(row: IAxisChangeRow): string[] {
	return [changeKindGlyph(row.kind), changeKindLabel(row.kind), row.name, row.folder, row.previousPath ?? '', changeRowLabel(row)];
}

/** Characters that must never reach the screen from a file name: controls (newline included), format and bidi controls, separators. */
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

function refOf(uri: URI | undefined): string | undefined {
	return uri && uri.scheme === 'git' ? JSON.parse(uri.query).ref : undefined;
}

suite('Axis Changes model', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('groups conflicts, staged, not staged and untracked in that order, each in path order', () => {
		const changes = readChanges(state({
			untrackedChanges: [change.added('new.txt')],
			workingTreeChanges: [change.modified('src/b.ts'), change.deleted('src/a.ts')],
			indexChanges: [change.added('docs/x.md'), change.renamed('old.ts', 'lib/new.ts')],
			mergeChanges: [change.modified('m.ts')],
		}), ROOT);
		assert.deepStrictEqual(changes.groups.map(g => [g.id, g.total]), [['conflicts', 1], ['staged', 2], ['unstaged', 2], ['untracked', 1]]);
		assert.deepStrictEqual(flatRows(changes).map(r => `${r.group}:${r.kind}:${r.folder}|${r.name}`), [
			'conflicts:conflict:|m.ts',
			'staged:added:docs|x.md',
			'staged:renamed:lib|new.ts',
			'unstaged:deleted:src|a.ts',
			'unstaged:modified:src|b.ts',
			'untracked:untracked:|new.txt',
		]);
		assert.strictEqual(changes.total, 6);
		assert.strictEqual(changes.outside, 0);
		assert.strictEqual(flatRows(changes)[2].previousPath, 'old.ts');
		assert.strictEqual(new Set(flatRows(changes).map(r => r.id)).size, 6, 'ids are unique');
	});

	test('a file both staged and changed again is listed in both groups', () => {
		const changes = readChanges(state({ indexChanges: [change.modified('a.ts')], workingTreeChanges: [change.modified('a.ts')] }), ROOT);
		assert.deepStrictEqual(flatRows(changes).map(r => r.id), [`staged:${file('a.ts')}`, `unstaged:${file('a.ts')}`]);
	});

	test('diff sides match the SCM view: staged is HEAD against the index, not staged is the index against the file', () => {
		const [stagedMod, stagedAdd, stagedDel, stagedRen] = flatRows(readChanges(state({
			indexChanges: [change.modified('a.ts'), change.added('b.ts'), change.deleted('c.ts'), change.renamed('d.ts', 'e.ts')],
		}), ROOT)).sort((x, y) => x.name < y.name ? -1 : 1);
		assert.deepStrictEqual([refOf(stagedMod.original), refOf(stagedMod.modified)], ['HEAD', '']);
		assert.deepStrictEqual([stagedAdd.original, refOf(stagedAdd.modified)], [undefined, '']);
		assert.deepStrictEqual([refOf(stagedDel.original), stagedDel.modified], ['HEAD', undefined]);
		assert.strictEqual(stagedDel.name, 'c.ts');
		assert.deepStrictEqual([stagedRen.original?.path, stagedRen.modified?.path], [file('d.ts').path, file('e.ts').path]);

		const [del, mod] = flatRows(readChanges(state({ workingTreeChanges: [change.modified('m.ts'), change.deleted('d.ts')] }), ROOT));
		assert.deepStrictEqual([refOf(mod.original), mod.modified?.toString()], ['~', file('m.ts').toString()], 'the right side is the file itself');
		assert.deepStrictEqual([refOf(del.original), del.modified], ['~', undefined]);

		const [untracked] = flatRows(readChanges(state({ untrackedChanges: [change.added('u.txt')] }), ROOT));
		assert.deepStrictEqual([untracked.original, untracked.modified?.toString()], [undefined, file('u.txt').toString()]);
		const [conflict] = flatRows(readChanges(state({ mergeChanges: [change.modified('c.txt')] }), ROOT));
		assert.deepStrictEqual([conflict.original, conflict.modified?.toString()], [undefined, file('c.txt').toString()]);
	});

	test('git URIs are the git extension\'s own shape', () => {
		const uri = toGitUri(file('src/a b.ts'), 'HEAD');
		assert.strictEqual(uri.scheme, 'git');
		assert.strictEqual(uri.path, file('src/a b.ts').path);
		assert.deepStrictEqual(JSON.parse(uri.query), { path: file('src/a b.ts').fsPath, ref: 'HEAD' });
	});

	test('changes outside the worktree, at its root itself or not on disk are dropped and counted', () => {
		const other = URI.file('/w/ws-b/x.ts');
		const changes = readChanges(state({
			workingTreeChanges: [
				change.raw(other, other, other),
				change.raw(file('in.ts'), other, file('in.ts')),
				change.raw(URI.file('/w/ws-a-evil/x.ts'), undefined, URI.file('/w/ws-a-evil/x.ts')),
				change.raw(ROOT, ROOT, ROOT),
				change.raw(file('v.ts').with({ scheme: 'vscode-remote' }), undefined, file('v.ts').with({ scheme: 'vscode-remote' })),
				change.raw(URI.file('/w/ws-a/../ws-b/y.ts'), undefined, URI.file('/w/ws-a/../ws-b/y.ts')),
				change.modified('kept.ts'),
			],
		}), ROOT);
		assert.deepStrictEqual(flatRows(changes).map(r => r.name), ['kept.ts']);
		assert.strictEqual(changes.outside, 6);
		assert.strictEqual(changes.total, 1);
	});

	test('a worktree that is not on local disk lists nothing (the diff sides need a file path)', () => {
		const remote = URI.from({ scheme: 'vscode-remote', authority: 'host', path: '/w/ws-a' });
		const inRemote = URI.joinPath(remote, 'x.ts');
		const changes = readChanges(state({ workingTreeChanges: [change.raw(inRemote, inRemote, inRemote)] }), remote);
		assert.deepStrictEqual(changes.groups, []);
		assert.strictEqual(changes.outside, 1);
	});

	test('a large group builds at most MAX_CHANGE_ROWS rows and keeps the full count', () => {
		const many = Array.from({ length: MAX_CHANGE_ROWS + 7 }, (_, i) => change.added(`f${String(i).padStart(4, '0')}.txt`)).reverse();
		const changes = readChanges(state({ untrackedChanges: many }), ROOT);
		assert.strictEqual(changes.groups[0].rows.length, MAX_CHANGE_ROWS);
		assert.strictEqual(changes.groups[0].total, MAX_CHANGE_ROWS + 7);
		assert.strictEqual(changes.groups[0].rows[0].name, 'f0000.txt', 'sorted before the cut, so the first files are listed');
		assert.match(changesSummary(changes), new RegExp(`${MAX_CHANGE_ROWS + 7}`));
	});

	test('no state and an empty state list nothing', () => {
		assert.deepStrictEqual(readChanges(undefined, ROOT), { groups: [], total: 0, outside: 0 });
		const empty = readChanges(state(), ROOT);
		assert.deepStrictEqual(empty.groups, []);
		assert.strictEqual(changesSummary(empty), 'No changes in this worktree.');
	});

	test('the accessible name starts with the fixed state and group, then the name', () => {
		const [row] = flatRows(readChanges(state({ indexChanges: [change.modified('src/app.ts')] }), ROOT));
		assert.strictEqual(changeRowLabel(row), 'Modified, Staged: app.ts, in src');
		const [root] = flatRows(readChanges(state({ untrackedChanges: [change.added('top.txt')] }), ROOT));
		assert.strictEqual(changeRowLabel(root), 'Untracked, Untracked: top.txt, at the worktree root');
		const [ren] = flatRows(readChanges(state({ indexChanges: [change.renamed('a/old.ts', 'b/new.ts')] }), ROOT));
		assert.strictEqual(changeRowLabel(ren), 'Renamed, Staged: new.ts, in b, renamed from a/old.ts');
		assert.strictEqual(changesSummary(readChanges(state({ indexChanges: [change.modified('a')], untrackedChanges: [change.added('b'), change.added('c')] }), ROOT)), '3 files: Staged 1, Untracked 2');
	});

	suite('hostile file names', () => {

		const HOSTILE: [string, string][] = [
			['newline', 'a\nStaged: b.ts'],
			['carriage return and tab', 'x\r\t.ts'],
			['NUL and escape', 'n\u0000\u001b[31mred.ts'],
			['right-to-left override', 'evil\u202Ests.exe'],
			['bidi isolates and marks', '\u2066a\u2069\u200F\u200E.ts'],
			['zero-width and BOM', 'z\u200B\u200C\u200D\uFEFF.ts'],
			['line and paragraph separators', 'l\u2028p\u2029.ts'],
			['C1 control', 'c\u0085\u009b.ts'],
			['stacked combining marks', `z${'\u0301'.repeat(40)}.ts`],
			['private use', 'p\uE000.ts'],
		];

		for (const [what, name] of HOSTILE) {
			test(`${what}: no unsafe character reaches the screen and the state stays first`, () => {
				const changes = readChanges(state({ untrackedChanges: [change.added(`dir\n${name}/${name}`)] }), ROOT);
				const [row] = flatRows(changes);
				for (const text of shown(row)) {
					assert.ok(!UNSAFE.test(text), `${JSON.stringify(text)} is shown as is`);
				}
				assert.ok(row.name.includes('�') || what === 'stacked combining marks', 'a replaced character stays visible');
				assert.strictEqual(row.kind, 'untracked', 'the state comes from the group, never the name');
				assert.ok(changeRowLabel(row).startsWith('Untracked, Untracked: '), 'the fixed state text leads the accessible name');
				assert.ok(row.resource.path.endsWith(name), 'the file opened is the real file, not the cleaned name');
			});
		}

		test('a name that spells another state cannot change the row state', () => {
			const [row] = flatRows(readChanges(state({ untrackedChanges: [change.added('Conflict, Staged: a.ts')] }), ROOT));
			assert.strictEqual(row.kind, 'untracked');
			assert.strictEqual(changeKindGlyph(row.kind), 'U');
			assert.strictEqual(changeRowLabel(row), 'Untracked, Untracked: Conflict, Staged: a.ts, at the worktree root');
		});

		test('very long names and folders are clamped with an ellipsis', () => {
			const long = 'n'.repeat(10_000);
			const folder = Array.from({ length: 200 }, () => 'dir').join('/');
			const [row] = flatRows(readChanges(state({ untrackedChanges: [change.added(`${folder}/${long}.ts`)] }), ROOT));
			assert.strictEqual([...row.name].length, MAX_CHANGE_NAME);
			assert.ok(row.name.endsWith('\u2026'));
			assert.strictEqual([...row.folder].length, MAX_CHANGE_FOLDER);
			assert.ok(changeRowLabel(row).length < MAX_CHANGE_NAME + MAX_CHANGE_FOLDER + 64);
			const astral = '\u{1F600}'.repeat(500);
			const [emoji] = flatRows(readChanges(state({ untrackedChanges: [change.added(astral)] }), ROOT));
			assert.strictEqual([...emoji.name].length, MAX_CHANGE_NAME, 'cut on code points, never inside a surrogate pair');
			assert.ok(!/[\uD800-\uDFFF](?![\uDC00-\uDFFF])/.test(emoji.name.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')));
		});

		test('labels for every state and group are fixed text', () => {
			const kinds = ['modified', 'added', 'deleted', 'renamed', 'untracked', 'conflict'] as const;
			assert.deepStrictEqual(kinds.map(changeKindGlyph), ['M', 'A', 'D', 'R', 'U', '!']);
			assert.deepStrictEqual(kinds.map(changeKindLabel), ['Modified', 'Added', 'Deleted', 'Renamed', 'Untracked', 'Conflict']);
			assert.deepStrictEqual((['conflicts', 'staged', 'unstaged', 'untracked'] as const).map(changeGroupLabel), ['Conflicts', 'Staged', 'Not staged', 'Untracked']);
		});
	});
});
