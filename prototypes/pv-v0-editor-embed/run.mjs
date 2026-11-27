// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-V0 harness: real upstream editor code (compiled at the pin) and the transpiled overlay prototype in headless
// Chromium. Each check prints PASS or FAIL with the observed value. Usage: node run.mjs [section]
import { createRequire } from 'node:module';
import { env, www } from './env.mjs';
import { startServer } from './serve.mjs';

const { chromium } = createRequire(import.meta.url)(env.playwrightCore());
const server = await startServer(www, env.port);
async function openPage(file, q = '') {
	const browser = await chromium.launch({ executablePath: env.chromium() });
	const page = await browser.newPage({ viewport: { width: 1100, height: 600 } });
	const errs = []; page.on('pageerror', e => errs.push(String(e))); page.on('console', m => m.type() === 'error' && errs.push(m.text()));
	await page.goto(`http://127.0.0.1:${env.port}/${file}?${q}`);
	await page.waitForFunction(() => window.ready, null, { timeout: 60000 }).catch(e => errs.push('not ready ' + e));
	return { browser, page, errs };
}
let failed = 0;
const check = (name, actual, expected) => { const ok = JSON.stringify(actual) === JSON.stringify(expected); if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} saw ${JSON.stringify(actual)}${ok ? '' : ' expected ' + JSON.stringify(expected)}`); };
const only = process.argv[2];

async function session(q, fn) { const { browser, page, errs } = await openPage('page.html', q); try { await fn(page); } finally { const other = errs.filter(e => !/editorWorkerService|ErrorEvent|dynamically imported module/.test(e)); if (other.length) console.log('page errors:', other.slice(0, 3)); await browser.close(); } }
const ev = (p, f, a) => p.evaluate(f, a);
const clickSide = async p => { await p.click('.axis-side-editor .view-lines'); };
const clickIde = async p => { await p.click('#ide .view-lines'); };
const reset = p => ev(p, () => { for (const k of Object.keys(log)) { log[k] = Array.isArray(log[k]) ? [] : 0; } });

if (!only || only === 'model') await session('', async p => {
	check('open a.ts in the side panel', await ev(p, () => openFile('a')), 'opened');
	check('both editors hold the same ITextModel', await ev(p, () => side.editor.getModel() === ide.getModel()), true);
	const v0 = await ev(p, () => models.A.getAlternativeVersionId());
	await clickSide(p); await p.keyboard.press('Control+End'); await p.keyboard.type('// side');
	check('side-panel typing shows in the IDE editor', await ev(p, () => ide.getModel().getValue().includes('// side')), true);
	check('dirty marker (alternative version) moved', await ev(p, v => models.A.getAlternativeVersionId() !== v, v0), true);
	await clickIde(p); for (let i = 0; i < 6; i++) await p.keyboard.press('Control+z');
	check('undo in the IDE editor undoes the side-panel edit', await ev(p, () => !models.A.getValue().includes('// side')), true);
	check('...and the model is back at the saved version', await ev(p, v => models.A.getAlternativeVersionId() === v, v0), true);
	await p.keyboard.press('Control+y');
	check('redo in the IDE editor redoes it', await ev(p, () => models.A.getValue().includes('/')), true);
	await reset(p); await ev(p, () => side.close());
	check('close releases the reference, model survives', await ev(p, () => [log.released, models.A.isDisposed(), side.editor.getModel()]), [1, false, null]);
	check('close returns the focus to the file row', await ev(p, () => where()), 'row-a');
	// Review S2: a reload from disk goes through modelService.updateModel, which pushes undo stops, so Ctrl+Z in the
	// side editor reverts the other writer's change into a dirty buffer. Shown here; the policy is in the report, §5.
	await ev(p, () => openFile('a')); await ev(p, () => modelService.updateModel(models.A, 'written on disk by a run\n'));
	const clean = await ev(p, () => models.A.getAlternativeVersionId());
	await clickSide(p); await p.keyboard.press('Control+z');
	check('[S2 hazard] undo reverts a reload from disk into a dirty buffer', await ev(p, c => [models.A.getValue().includes('written on disk'), models.A.getAlternativeVersionId() !== c], clean), [false, true]);
});

if (!only || only === 'route') for (const q of ['', 'noroutes']) await session(q, async p => {
	const tag = q ? 'no Axis routes: upstream misroute' : 'Axis routes';
	await ev(p, () => openFile('a')); await clickSide(p); await p.keyboard.type('x'); await reset(p);
	await p.keyboard.press('Control+s');
	check(`[${tag}] Ctrl+S in side editor saves a.ts, not the IDE editor`, await ev(p, () => [log.save, log.upstream]), q ? [[], ['workbench.action.files.save']] : [[['/w/repo/a.ts', false]], []]);
	await reset(p); await p.keyboard.press('Control+k'); await p.keyboard.press('s');
	check(`[${tag}] Ctrl+K S saves without formatting`, await ev(p, () => [log.save, log.upstream]), q ? [[], ['workbench.action.files.saveWithoutFormatting']] : [[['/w/repo/a.ts', true]], []]);
	await reset(p); await ev(p, () => side.editor.setSelection({ startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 8 }));
	await p.keyboard.press('Control+Shift+s'); await p.keyboard.press('Control+Backslash');
	// The hand-off carries the side editor's selection, so IDE view opens where the user was (review r3 N5).
	check(`[${tag}] Save As and Split hand off to IDE view with the selection`, await ev(p, () => [log.reveal, log.upstream]), q ? [[], ['workbench.action.files.saveAs', 'workbench.action.splitEditor']] : [[['/w/repo/a.ts', '[1,7 -> 1,8]'], ['/w/repo/a.ts', '[1,7 -> 1,8]']], []]);
	await reset(p); await p.keyboard.press('Control+k'); await p.keyboard.press('p');
	check(`[${tag}] Ctrl+K P (copy path) hands off instead of copying the IDE file`, await ev(p, () => [log.reveal.length, log.upstream]), q ? [0, ['workbench.action.files.copyPathOfActiveFile']] : [1, []]);
	await reset(p); await p.keyboard.press('Control+PageDown'); await p.keyboard.press('Control+k'); await p.keyboard.press('w');
	check(`[${tag}] tab and group keys are blocked, not run on the IDE`, await ev(p, () => [log.blocked, log.upstream]), q ? [[], ['workbench.action.nextEditor', 'workbench.action.closeEditorsInGroup']] : [['workbench.action.nextEditor', 'workbench.action.closeEditorsInGroup'], []]);
	await reset(p); await ev(p, () => commands.executeCommand('workbench.action.files.save', models.uriB));
	check(`[${tag}] a command given an explicit target runs upstream`, await ev(p, () => [log.save, log.upstream]), [[], [['workbench.action.files.save', 1]]]);
	await reset(p); await p.keyboard.type('y'); await clickIde(p);
	check(`[${tag}] side editor blur reported (auto-save on focus change)`, await ev(p, () => log.focusLost), ['/w/repo/a.ts']);
	await reset(p);
	await ev(p, () => commands.executeCommand('workbench.action.files.saveAll'));
	check(`[${tag}] Save All also saves the dirty side-panel file`, await ev(p, () => [log.upstream, log.save]), q ? [['workbench.action.files.saveAll'], []] : [['workbench.action.files.saveAll'], [['/w/repo/a.ts', false]]]);
	await clickSide(p); await reset(p); await p.keyboard.press('Control+w');
	check(`[${tag}] Ctrl+W closes the side editor, not an IDE editor`, await ev(p, () => [log.upstream, side.currentResource?.path ?? null, where()]), q ? [['workbench.action.closeActiveEditor'], '/w/repo/a.ts', 'side-editor'] : [[], null, 'row-a']);
	await clickIde(p); await reset(p); await p.keyboard.press('Control+s');
	check(`[${tag}] Ctrl+S in the IDE editor stays upstream`, await ev(p, () => [log.save.length, log.upstream]), [0, ['workbench.action.files.save']]);
	if (!q) {
		// Review r4 N1: a guard over a command whose metadata declares arguments is still reported as guarded.
		check('every policy command present was guarded, none missing', await ev(p, () => [registration.guarded.length, registration.guarded.includes('workbench.action.editor.changeLanguageMode'), registration.missing.includes('workbench.action.files.save')]), [10, true, false]);
		// Review r2 N1: a later registration of a guarded id (an extension, or a core command registered at runtime).
		// Review r3 N3: each later registration adds exactly one guard layer (the late command, then its guard).
		const layers = await ev(p, () => { const { CommandsRegistry, KeybindingsRegistry, KeyMod, KeyCode } = registries;
			const events = []; const l = CommandsRegistry.onDidRegisterCommand(id => events.push(id));
			window.lateSave = CommandsRegistry.registerCommand('workbench.action.files.save', () => log.upstream.push('late save'));
			KeybindingsRegistry.registerCommandAndKeybindingRule({ id: 'workbench.action.tasks.build', weight: 200, when: undefined, primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyB, handler: () => log.upstream.push('late build') });
			l.dispose(); return events; });
		check('each later registration adds one guard layer', layers, ['workbench.action.files.save', 'workbench.action.files.save', 'workbench.action.tasks.build', 'workbench.action.tasks.build']);
		await ev(p, () => openFile('a')); await clickSide(p); await reset(p);
		await p.keyboard.press('Control+s'); await ev(p, () => commands.executeCommand('workbench.action.tasks.build')); // a late keybinding is not read by the standalone dispatcher
		check('a later registration is guarded again (save, run task)', await ev(p, () => [log.save.length, log.reveal.length, log.upstream, registration.missing.includes('workbench.action.tasks.build')]), [1, 1, [], false]);
		await reset(p); await ev(p, () => commands.executeCommand('workbench.action.files.save', {}));
		check('keybinding args {} are not an explicit target', await ev(p, () => [log.save.length, log.upstream]), [1, []]);
		await clickIde(p); await reset(p); await p.keyboard.press('Control+s');
		check('...and the later registration still runs from the IDE editor', await ev(p, () => log.upstream), ['late save']);
		// Review r3 N1: the late registration goes away (its extension deactivates); its guard goes with it, so the IDE
		// editor's Save reaches the handler below again instead of the removed one, and the side editor is still guarded.
		await ev(p, () => window.lateSave.dispose()); await reset(p); await p.keyboard.press('Control+s');
		check('a disposed later registration takes its guard with it', await ev(p, () => [log.upstream, registration.guarded.includes('workbench.action.files.save')]), [['workbench.action.files.save'], true]);
		await clickSide(p); await reset(p); await p.keyboard.press('Control+s');
		check('...and the side editor is still guarded', await ev(p, () => [log.save.length, log.upstream]), [1, []]);
		// Review r4 N2: a second install (an auxiliary window sharing the registry) adds no layer, and the guards stay until
		// the last handle is disposed, whatever the order.
		const second = await ev(p, () => { const events = []; const l = registries.CommandsRegistry.onDidRegisterCommand(id => events.push(id));
			window.registration2 = sp.registerAxisSidePanelEditorCommands(); l.dispose(); return [events.length, registration2.guarded.length]; });
		check('a second install adds no guard layer and sees the same guards (the late Tasks: Build included)', second, [0, 11]);
		await ev(p, () => { registration.dispose(); registration.dispose(); }); await reset(p); await p.keyboard.press('Control+s');
		check('...disposing the first handle (twice) keeps the guards for the second', await ev(p, () => [log.save.length, log.upstream, registration2.guarded.length]), [1, [], 11]);
		await ev(p, () => registration2.dispose()); await reset(p); await p.keyboard.press('Control+s');
		check('disposing the registration restores upstream Save and the registry method', await ev(p, () => [log.save.length, log.upstream, registries.CommandsRegistry.registerCommand === Object.getPrototypeOf(registries.CommandsRegistry).registerCommand]), [0, ['workbench.action.files.save'], true]);
	}
});

if (!only || only === 'keys') await session('', async p => {
	await ev(p, () => openFile('a')); await clickSide(p);
	await p.keyboard.press('Control+f'); await p.waitForSelector('.axis-side-editor .find-widget.visible');
	await p.keyboard.press('Escape');
	check('Escape first closes the find widget, focus stays', await ev(p, () => [document.querySelector('.axis-side-editor .find-widget.visible') === null, where()]), [true, 'side-editor']);
	await p.keyboard.press('Control+Home'); await p.keyboard.press('Shift+End');
	const selected = await ev(p, () => !side.editor.getSelection().isEmpty());
	await p.keyboard.press('Escape');
	check('Escape with a selection clears it, focus stays', [selected, ...await ev(p, () => [side.editor.getSelection().isEmpty(), where()])], [true, true, 'side-editor']);
	await p.keyboard.press('Escape');
	check('Escape with nothing to close leaves to the file row', await ev(p, () => where()), 'row-a');
	await clickSide(p); const before = await ev(p, () => models.A.getValue());
	await p.keyboard.press('Tab');
	check('Tab indents and keeps the focus (tab trap)', await ev(p, b => [models.A.getValue() !== b, where()], before), [true, 'side-editor']);
	await p.keyboard.press('Control+z'); await p.keyboard.press('Control+m'); await p.keyboard.press('Tab');
	check('Ctrl+M (tab moves focus) then Tab leaves the editor', await ev(p, () => where()), 'side-editor-left');
	await clickSide(p); await reset(p); await p.keyboard.press('F6');
	check('no editor binding claims F6 (workbench part cycle gets it)', await ev(p, () => log.window.at(-1)), ['F6', null]);
	check('registry: F6 bindings with editor contributions loaded', await ev(p, async () => (await import('./vs/platform/keybinding/common/keybindingsRegistry.js')).KeybindingsRegistry.getDefaultKeybindings().filter(k => k.keybinding?.chords?.length === 1 && k.keybinding.chords[0].keyCode === 64 && !k.keybinding.chords[0].ctrlKey && !k.keybinding.chords[0].altKey).map(k => k.command)), []);
	const aria = await ev(p, () => { const t = document.querySelector('.axis-side-editor .native-edit-context, .axis-side-editor textarea.inputarea'); return [t.getAttribute('aria-label'), t.getAttribute('aria-readonly'), t.getAttribute('role')]; });
	check('input label and role', [aria[0], aria[2]], ['a, side panel editor', 'textbox']);
});

if (!only || only === 'approve') await session('', async p => {
	await ev(p, () => openFile('a')); await clickSide(p); await ev(p, () => addCard('c1'));
	check('a card appearing does not take the focus', await ev(p, () => where()), 'side-editor');
	const lines = await ev(p, () => models.A.getLineCount()); await reset(p);
	await p.keyboard.press('Control+Enter');
	check('Ctrl+Enter in side editor: Insert Line Below, no approval', await ev(p, l => [models.A.getLineCount() - l, log.approve, log.window.at(-1)], lines), [1, [], ['Enter', 'editor.action.insertLineAfter']]);
	await reset(p); await p.focus('#c1 .deny'); await p.keyboard.press('Control+Enter');
	check('Ctrl+Enter on the card: approves; Enter never bubbles to window', await ev(p, () => [log.approve, log.window.at(-1), log.bubble.filter(k => k === 'Enter').length]), [['c1'], ['Enter', null], 0]);
	await reset(p); await p.focus('#composer'); await p.keyboard.press('Control+Enter');
	check('Ctrl+Enter in the composer: no approval', await ev(p, () => log.approve), []);
	await reset(p); await ev(p, () => document.querySelector('#c1 .deny').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })));
	check('script-dispatched Ctrl+Enter on the card: refused', await ev(p, () => [log.approve, log.refused]), [[], [['c1', false, false]]]);
	await reset(p); await p.focus('#c1 .deny'); await p.keyboard.down('Control'); await p.keyboard.down('Enter'); await p.keyboard.down('Enter'); await p.keyboard.up('Enter'); await p.keyboard.up('Control');
	check('held Ctrl+Enter: first press approves, repeat refused', await ev(p, () => [log.approve, log.refused]), [['c1'], [['c1', true, true]]]);
	await ev(p, () => addCard('c2', true)); await p.click('#nested .view-lines'); await reset(p);
	await p.keyboard.press('Control+Enter');
	check('editor nested in a card: no approval, line inserted', await ev(p, () => [log.approve, nested.getModel().getLineCount()]), [[], 2]);
	await reset(p);
	await ev(p, () => window.workbenchStyle = true); await p.keyboard.press('Control+Enter');
	check('...workbench-style bubbling: the card gate refuses it', await ev(p, () => [log.approve, log.refused.map(r => r[0])]), [[], ['c2']]);
});

if (!only || only === 'trust') await session('user=' + encodeURIComponent(JSON.stringify({ unicodeHighlight: { invisibleCharacters: false, ambiguousCharacters: false }, renderControlCharacters: false, minimap: { enabled: true }, fontSize: 19 })), async p => {
	check('open a.ts trusted, then b.ts untrusted in the same widget', await ev(p, async () => [await openFile('a', true), await openFile('b', false), side.editor.getModel().uri.path]), ['opened', 'opened', '/w/repo/b.ts']);
	const before = await ev(p, () => side.editor.getModel().getValue());
	await clickSide(p); await p.keyboard.type('zz'); await reset(p); await p.keyboard.press('Control+s');
	check('untrusted: typing ignored, Save does nothing', await ev(p, b => [side.editor.getModel().getValue() === b, log.save.length, log.upstream.length], before), [true, 0, 0]);
	const ro = await ev(p, () => { const t = document.querySelector('.axis-side-editor .native-edit-context, .axis-side-editor textarea.inputarea'); return [t.className, t.getAttribute('aria-readonly'), t.getAttribute('aria-label')]; });
	check('untrusted: no aria-readonly on EditContext; label says read-only', ro, ['native-edit-context', null, 'b, side panel editor, read-only (Restricted Mode)']);
	const o = await ev(p, () => { const e = side.editor; return [e.getOption(97/*placeholder*/) === undefined, e.getRawOptions().unicodeHighlight, e.getRawOptions().renderControlCharacters, e.getRawOptions().minimap, e.getRawOptions().fontSize]; });
	check('user settings kept, forced options win', o.slice(1), [{ invisibleCharacters: true, ambiguousCharacters: true }, true, { enabled: false }, 19]);
	await p.waitForTimeout(400);
	check('hidden RLO and zero-width characters are highlighted', await ev(p, () => document.querySelectorAll('.axis-side-editor .unicode-highlight, .axis-side-editor .mtkcontrol').length > 0), true);
	await ev(p, () => openFile('a', true)); await clickSide(p); const a0 = await ev(p, () => models.A.getValue()); await reset(p);
	await p.keyboard.type('q'); await p.keyboard.press('Control+s');
	check('reopened trusted: editable and saves again', await ev(p, b => [models.A.getValue() !== b, log.save], a0), [true, [['/w/repo/a.ts', false]]]);
	// Review r3 N5: Save All never saves a read-only (untrusted) file, even one the IDE made dirty.
	await ev(p, () => openFile('b', false)); await ev(p, () => side.editor.getModel().applyEdits([{ range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 }, text: '// ide\n' }])); await reset(p);
	await ev(p, () => commands.executeCommand('workbench.action.files.saveAll'));
	check('untrusted and dirty: Save All does not save it', await ev(p, () => [isDirty(models.uriB), log.save, log.upstream, log.blocked]), [true, [], ['workbench.action.files.saveAll'], []]);
	await ev(p, () => side.close()); check('open a missing file: unavailable', await ev(p, () => openFile('missing.ts')), 'unavailable');
});

if (!only || only === 'conflict') await session('overwrite=1', async p => {
	await ev(p, () => openFile('a')); await clickSide(p); await p.keyboard.type('x'); await reset(p);
	await p.keyboard.press('Control+s'); await ev(p, () => commands.executeCommand('workbench.action.files.saveAll'));
	// Save and Save All are both refused, and both say so (review r3 N4).
	check('overwriteFileOnDisk: the side panel refuses Save and Save All, naming the setting', await ev(p, () => [log.save, log.blocked]), [[], ['files.saveConflictResolution', 'files.saveConflictResolution']]);
});
// Review r4 N4: a host whose read of the setting throws refuses both saves, and says so.
if (!only || only === 'conflict') await session('overwrite=throw', async p => {
	await ev(p, () => openFile('a')); await clickSide(p); await p.keyboard.type('x'); await reset(p);
	await p.keyboard.press('Control+s'); await ev(p, () => commands.executeCommand('workbench.action.files.saveAll'));
	check('a throwing setting read: Save and Save All are refused, naming the setting', await ev(p, () => [log.save, log.blocked, log.upstream]), [[], ['files.saveConflictResolution', 'files.saveConflictResolution'], ['workbench.action.files.saveAll']]);
});

if (!only || only === 'race') await session('delay=150', async p => {
	const r = await ev(p, async () => { const a = openFile('a'); const b = openFile('b'); return [await a, await b, side.currentResource.path, side.editor.getModel().uri.path, log.released]; });
	check('slow open of a.ts superseded by b.ts; a.ts reference released', r, ['superseded', 'opened', '/w/repo/b.ts', '/w/repo/b.ts', 1]);
	const c = await ev(p, async () => { const a = openFile('a'); side.close(); return [await a, side.editor.getModel(), side.currentResource ?? null, log.released]; });
	check('close while resolving: nothing shown, references released', c, ['superseded', null, null, 3]);
	const d = await ev(p, async () => { const a = openFile('a'); const m = openFile('missing.ts'); side.dispose(); return [await a, await m, log.released]; });
	check('dispose while resolving (and a failed open): disposed', d, ['disposed', 'disposed', 4]);
});
server.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
