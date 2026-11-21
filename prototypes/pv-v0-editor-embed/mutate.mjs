// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Mutation check of the PV-V0 prototype: each mutant of the overlay must make the unit tests or the browser harness
// fail. Mutants are written to a copy under AXIS_PV_V0_WORK; the repository is never changed.
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from './env.mjs';

const C = 'contrib/sidePanel/common/axisSidePanelEditor.ts';
const B = 'contrib/sidePanel/browser/axisSidePanelEditor.ts';
const MUTANTS = [
	['guard: ignores focus', C, 'return sidePanelFocused && argumentCount === 0 ? action : undefined;', 'return action;', 'route'],
	['guard: ignores explicit arguments', C, 'return sidePanelFocused && argumentCount === 0 ? action : undefined;', 'return sidePanelFocused ? action : undefined;', 'route'],
	['policy: Save accepted', C, "['workbench.action.files.save', 'save'],", "['workbench.action.files.save', 'accept'],", 'route'],
	['policy: Save All not extended', C, "['workbench.action.files.saveAll', 'saveAllToo'],", "['workbench.action.files.saveAll', 'accept'],", 'route'],
	['policy: tab and group commands accepted', C, "...BLOCK.map(id => [id, 'block'] as const),", "...BLOCK.map(id => [id, 'accept'] as const),", 'route'],
	['policy: open-in-IDE commands accepted', C, "...OPEN_IN_IDE.map(id => [id, 'openInIde'] as const),", "...OPEN_IN_IDE.map(id => [id, 'accept'] as const),", 'route'],
	['Escape weight above editor bindings', C, 'LEAVE_WEIGHT = -1', 'LEAVE_WEIGHT = 150', 'keys'],
	['user settings win over forced', C, 'result[key] = isPlainObject(value) && isPlainObject(mine) ? { ...mine, ...value } : value;', 'result[key] = mine === undefined ? value : mine;', 'trust'],
	['untrusted not read-only', C, 'readOnly: !input.trusted,', 'readOnly: false,', 'trust'],
	['invisible characters not forced', C, 'unicodeHighlight: { invisibleCharacters: true, ambiguousCharacters: true },', 'unicodeHighlight: {},', 'trust'],
	['label not cleaned', C, '"{0}, side panel editor", cleanDisplayText(input.label, MAX_LABEL))', '"{0}, side panel editor", input.label)', 'trust'],
	['approval: isTrusted dropped', C, 'return event.isTrusted === true\n\t\t&& event.repeat', 'return true\n\t\t&& event.repeat', 'approve'],
	['approval: repeat allowed', C, '&& event.repeat === false', '', 'approve'],
	['approval: composition allowed', C, '&& event.isComposing !== true\n', '', 'approve'],
	['approval: editor check dropped', C, '&& !scope.isInEditor(scope.activeElement)\n\t\t&& !scope.isInEditor(event.target);', ';', 'approve'],
	['approval: focus-in-card dropped', C, '&& scope.card.contains(scope.activeElement)\n', '', 'approve'],
	['race: generation check dropped', B, 'if (generation !== this.generation) {', 'if (false) {', 'race'],
	['race: superseded reference kept', B, 'reference.dispose();\n\t\t\treturn \'superseded\';', 'return \'superseded\';', 'race'],
	['dispose: reference kept', B, 'reference.dispose();\n\t\t\treturn \'disposed\';', 'return \'disposed\';', 'race'],
	['failed open after dispose not disposed', B, "this._store.isDisposed ? 'disposed' : generation", 'generation', 'race'],
	['reopen keeps the previous model (review M1)', B, 'this.widget.setModel(reference.object.textEditorModel);', 'if (!this.widget.getModel()) {\n\t\t\tthis.widget.setModel(reference.object.textEditorModel);\n\t\t}', 'trust'],
	['reopen keeps the previous options (review M2)', B, '\t\t\tthis.widget.updateOptions(options);\n', '', 'trust'],
	['close does not cancel an open (review M3)', B, '\t\tthis.generation++;\n\t\tthis.widget?.setModel(null);', '\t\tthis.widget?.setModel(null);', 'race'],
	['close keeps the reference', B, 'this.reference.clear();', '', 'model'],
	['save ignores read-only', B, 'return !this.widget || this.widget.getOption(EditorOption.readOnly);', 'return !this.widget;', 'trust'],
	['close does not return focus', B, '\t\tthis.resource = undefined;\n\t\tthis.leave();', '\t\tthis.resource = undefined;', 'model'],
	['blur not reported', B, 'this.hostServices.focusLost(shown);', '', 'route'],
];

const copy = join(env.work, 'mutant-src');
const node = (script, args = [], extra = {}) => spawnSync(process.execPath, [join(env.here, script), ...args], { encoding: 'utf8', env: { ...process.env, ...extra } });

function verdict(section) {
	if (node('prepare.mjs', [], { AXIS_OVERLAY_SRC: copy }).status !== 0) {
		return 'prepare failed';
	}
	const unit = node('unit.mjs').status !== 0 ? 'unit' : '';
	const harness = node('run.mjs', [section]).status !== 0 ? 'harness' : '';
	return [unit, harness].filter(Boolean).join('+');
}

let killed = 0;
for (const [name, file, from, to, section] of MUTANTS) {
	rmSync(copy, { recursive: true, force: true });
	cpSync(env.overlay, copy, { recursive: true });
	const path = join(copy, file);
	const text = readFileSync(path, 'utf8');
	if (text.split(from).length !== 2) {
		console.log(`SKIP      ${name}: pattern not found exactly once`);
		continue;
	}
	writeFileSync(path, text.replace(from, to));
	const result = verdict(section);
	killed += result ? 1 : 0;
	console.log(`${result ? 'KILLED  ' : 'SURVIVED'}  ${name.padEnd(40)} ${result}`);
}
rmSync(copy, { recursive: true, force: true });
cpSync(env.overlay, copy, { recursive: true });
console.log(`baseline: ${verdict('') || 'clean'}`);
rmSync(copy, { recursive: true, force: true });
node('prepare.mjs');
console.log(`${killed}/${MUTANTS.length} killed`);
process.exit(killed === MUTANTS.length ? 0 : 1);
