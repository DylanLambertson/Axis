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
	['route weight below WorkbenchContrib', C, 'ROUTE_WEIGHT = 201', 'ROUTE_WEIGHT = 199', 'route'],
	['Escape weight above editor bindings', C, 'LEAVE_WEIGHT = -1', 'LEAVE_WEIGHT = 150', 'keys'],
	['user settings win over forced', C, 'result[key] = isPlainObject(value) && isPlainObject(mine) ? { ...mine, ...value } : value;', 'result[key] = mine === undefined ? value : mine;', 'trust'],
	['untrusted not read-only', C, 'readOnly: !input.trusted,', 'readOnly: false,', 'trust'],
	['invisible characters not forced', C, 'unicodeHighlight: { invisibleCharacters: true, ambiguousCharacters: true },', 'unicodeHighlight: {},', 'trust'],
	['approval: isTrusted dropped', C, 'return event.isTrusted === true\n\t\t&& event.repeat', 'return true\n\t\t&& event.repeat', 'approve'],
	['approval: repeat allowed', C, '&& event.repeat === false', '', 'approve'],
	['approval: editor check dropped', C, '&& !scope.isInEditor(scope.activeElement)\n\t\t&& !scope.isInEditor(event.target);', ';', 'approve'],
	['approval: focus-in-card dropped', C, '&& scope.card.contains(scope.activeElement)\n', '', 'approve'],
	['race: generation check dropped', B, 'if (generation !== this.generation) {', 'if (false) {', 'race'],
	['race: superseded reference kept', B, 'reference.dispose();\n\t\t\treturn \'superseded\';', 'return \'superseded\';', 'race'],
	['dispose: reference kept', B, 'reference.dispose();\n\t\t\treturn \'disposed\';', 'return \'disposed\';', 'race'],
	['close keeps the reference', B, 'this.reference.clear();', '', 'model'],
	['save ignores read-only', B, 'if (this.widget && !this.widget.getOption(EditorOption.readOnly)) {', 'if (this.widget) {', 'trust'],
	['close does not return focus', B, '\t\tthis.resource = undefined;\n\t\tthis.leave();', '\t\tthis.resource = undefined;', 'model'],
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
