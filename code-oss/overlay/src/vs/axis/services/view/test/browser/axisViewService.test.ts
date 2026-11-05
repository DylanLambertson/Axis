/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { TestStorageService } from '../../../../../workbench/test/common/workbenchTestServices.js';
import { IAxisWorkbenchLayoutService } from '../../../../browser/axisLayoutService.js';
import { AXIS_VIEW_MODE_SETTING, AxisSplitCollapse, IAxisLayoutRequest } from '../../../../common/axisView.js';
import { AxisViewService, IAxisViewChange } from '../../browser/axisViewService.js';
import { AXIS_GLOBAL_VIEW_STORAGE_KEY, AXIS_WORKSPACE_VIEWS_STORAGE_KEY, AxisViewState, MAX_WORKSPACE_VIEW_RECORDS } from '../../common/axisViewState.js';

function describe(request: IAxisLayoutRequest): string {
	return request.kind === 'split' ? `split:${request.collapsed}` : request.kind;
}

/** Records layout calls; stands in for `AxisWorkbench`, whose grid needs a real window. */
class FakeAxisLayout {
	readonly onDidCreateAgentPartEmitter = new Emitter<void>();
	readonly onDidCreateAgentPart = this.onDidCreateAgentPartEmitter.event;
	readonly onDidApplyLayout = Event.None;
	readonly onDidRequestIdeViewEmitter = new Emitter<void>();
	readonly onDidRequestIdeView = this.onDidRequestIdeViewEmitter.event;

	readonly whenRestored = new Promise<void>(() => { /* restore never completes in these tests */ });
	readonly applied: string[] = [];
	readonly focused: string[] = [];
	agentPartCreated = false;
	appliedLayout: IAxisLayoutRequest | undefined;

	/** Stands in for the agent part's DOM; focusing the agent part focuses this element. */
	readonly agentElement = mainWindow.document.createElement('div');
	readonly agentFocusTarget = mainWindow.document.createElement('button');
	readonly agentPart = {
		element: this.agentElement,
		hasFocus: () => this.agentElement.contains(mainWindow.document.activeElement),
		focus: () => this.agentFocusTarget.focus(),
		setContent: () => { },
		onDidRequestCollapse: Event.None as Event<AxisSplitCollapse>,
	};

	constructor() {
		this.agentElement.appendChild(this.agentFocusTarget);
		mainWindow.document.body.appendChild(this.agentElement);
	}

	hasAgentPart(): boolean { return this.agentPartCreated; }
	getAgentPart() { return this.agentPartCreated ? this.agentPart : undefined; }
	applyLayout(request: IAxisLayoutRequest): void {
		if (!this.appliedLayout || describe(this.appliedLayout) !== describe(request)) {
			this.applied.push(describe(request));
		}
		this.appliedLayout = request;
	}
	isVisible(): boolean { return this.appliedLayout?.kind !== 'agent'; }
	focusAgentPart(): void { this.focused.push('agent'); this.agentPart.focus(); }
	focusPart(part: string): void { this.focused.push(part); }

	createAgentPart(): void {
		this.agentPartCreated = true;
		this.onDidCreateAgentPartEmitter.fire();
	}

	dispose(): void {
		this.agentElement.remove();
		this.onDidCreateAgentPartEmitter.dispose();
		this.onDidRequestIdeViewEmitter.dispose();
	}
}

class FakeEditorService {
	readonly opened: string[] = [];
	activeEditorPane = undefined;
	async openEditor(input: { resource: URI }): Promise<undefined> {
		this.opened.push(input.resource.path);
		return undefined;
	}
}

suite('Axis view service', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let disposables: DisposableStore;
	let storage: TestStorageService;
	let configuration: TestConfigurationService;
	let layout: FakeAxisLayout;
	let editors: FakeEditorService;

	setup(() => {
		disposables = store.add(new DisposableStore());
		storage = disposables.add(new TestStorageService());
		configuration = new TestConfigurationService({ [AXIS_VIEW_MODE_SETTING]: 'perWorkspace' });
		layout = new FakeAxisLayout();
		editors = new FakeEditorService();
		disposables.add({ dispose: () => layout.dispose() });
	});

	function createService(): AxisViewService {
		const contextKeyService = disposables.add(new ContextKeyService(configuration));
		return disposables.add(new AxisViewService(layout as unknown as IAxisWorkbenchLayoutService, storage as IStorageService, configuration, contextKeyService, editors as unknown as IEditorService));
	}

	test('applies the restored view as soon as the agent part exists', () => {
		const service = createService();
		assert.deepStrictEqual(layout.applied, []);

		layout.createAgentPart();
		assert.deepStrictEqual(layout.applied, ['agent'], 'Axis is agent-first: no record means the Agent view');
		assert.strictEqual(service.activeView, 'agent');
		assert.deepStrictEqual(layout.focused, [], 'restoring a view must not move focus');
	});

	test('applies immediately when the agent part already exists', () => {
		layout.agentPartCreated = true;
		new AxisViewState(storage).set('perWorkspace', undefined, 'ide');
		createService();
		assert.deepStrictEqual(layout.applied, ['ide']);
	});

	test('toggle swaps views, focuses the destination and records the view', () => {
		layout.agentPartCreated = true;
		const service = createService();
		const changes: IAxisViewChange[] = [];
		disposables.add(service.onDidChangeView(change => changes.push(change)));

		service.toggle();
		service.toggle();
		assert.deepStrictEqual(layout.applied, ['agent', 'ide', 'agent']);
		assert.deepStrictEqual(changes.map(c => c.view), ['ide', 'agent']);
		assert.deepStrictEqual(layout.focused, ['workbench.parts.editor', 'agent']);
		assert.strictEqual(new AxisViewState(storage).get('perWorkspace', undefined), 'agent');
	});

	test('a toggle back restores the element focused before the switch (focus rule 2)', () => {
		layout.agentPartCreated = true;
		const service = createService();
		const row = mainWindow.document.createElement('button');
		layout.agentElement.appendChild(row);

		row.focus();
		service.toggle(); // to the IDE view
		service.toggle(); // back
		assert.strictEqual(mainWindow.document.activeElement, row);
		assert.deepStrictEqual(layout.focused, ['workbench.parts.editor'], 'the remembered row wins over the primary region');
	});

	test('perWorkspace: focusing a workspace applies that workspace\'s view', () => {
		layout.agentPartCreated = true;
		const service = createService();

		service.setFocusedWorkspace('ws-a', 'a');
		service.show('ide');
		service.setFocusedWorkspace('ws-b', 'b');
		assert.strictEqual(service.activeView, 'agent', 'ws-b has no record');
		service.setFocusedWorkspace('ws-a', 'a');
		assert.strictEqual(service.activeView, 'ide');
		assert.strictEqual(service.currentView('ws-b'), 'agent');
	});

	test('global: focusing another workspace keeps the view', () => {
		configuration.setUserConfiguration(AXIS_VIEW_MODE_SETTING, 'global');
		layout.agentPartCreated = true;
		const service = createService();
		assert.strictEqual(service.mode, 'global');

		service.setFocusedWorkspace('ws-a');
		service.show('ide');
		service.setFocusedWorkspace('ws-b');
		assert.strictEqual(service.activeView, 'ide');
		assert.strictEqual(storage.get(AXIS_GLOBAL_VIEW_STORAGE_KEY, StorageScope.APPLICATION), 'ide');
		assert.strictEqual(storage.get(AXIS_WORKSPACE_VIEWS_STORAGE_KEY, StorageScope.WORKSPACE), undefined);
	});

	test('split: both halves show, the toggle moves focus between them, collapse keeps the other half', () => {
		configuration.setUserConfiguration(AXIS_VIEW_MODE_SETTING, 'split');
		layout.agentPartCreated = true;
		const service = createService();
		assert.deepStrictEqual(layout.applied, ['split:none']);

		layout.agentPart.focus();
		service.toggle();
		assert.deepStrictEqual(layout.focused, ['workbench.parts.editor'], 'from the agent half to the IDE half');
		assert.deepStrictEqual(layout.applied, ['split:none'], 'the toggle never changes the split layout');

		service.setSplitCollapsed('ide');
		assert.strictEqual(service.splitCollapsed, 'ide');
		assert.strictEqual(service.activeView, 'agent', 'focus leaves the collapsing half');
		service.show('ide');
		assert.deepStrictEqual(layout.applied, ['split:none', 'split:ide', 'split:none'], 'showing a collapsed half expands it');
	});

	test('reveal opens the location in the IDE view per mode', async () => {
		layout.agentPartCreated = true;
		const service = createService();
		service.setFocusedWorkspace('ws-a', 'a');

		await service.reveal({ resource: URI.file('/w/a/src/x.ts'), selection: { startLineNumber: 3, startColumn: 1 } });
		assert.deepStrictEqual(editors.opened, ['/w/a/src/x.ts']);
		assert.strictEqual(service.activeView, 'ide');
		assert.strictEqual(service.currentView('ws-a'), 'ide', 'perWorkspace records the switch for the workspace');

		configuration.setUserConfiguration(AXIS_VIEW_MODE_SETTING, 'split');
		configuration.onDidChangeConfigurationEmitter.fire({ affectsConfiguration: (key: string) => key === AXIS_VIEW_MODE_SETTING, affectedKeys: new Set([AXIS_VIEW_MODE_SETTING]) } as never);
		service.setSplitCollapsed('ide');
		await service.reveal({ resource: URI.file('/w/a/src/y.ts') });
		assert.strictEqual(layout.applied.at(-1), 'split:none', 'split: the collapsed IDE half expands, no view switch');
	});

	test('an editor revealed while the Agent view shows switches to the IDE view, focusing it only if focus would be lost', () => {
		layout.agentPartCreated = true;
		const service = createService();
		const input = mainWindow.document.createElement('input');
		mainWindow.document.body.appendChild(input);
		disposables.add({ dispose: () => input.remove() });

		input.focus();
		layout.onDidRequestIdeViewEmitter.fire();
		assert.strictEqual(service.activeView, 'ide');
		assert.deepStrictEqual(layout.focused, [], 'focus stays where the open put it');

		service.show('agent', { focus: false });
		input.blur();
		layout.onDidRequestIdeViewEmitter.fire();
		assert.deepStrictEqual(layout.focused, ['workbench.parts.editor'], 'focus never falls to the body');
	});

	test('the view state survives a new service instance (persistence round trip)', () => {
		layout.agentPartCreated = true;
		const first = createService();
		first.setFocusedWorkspace('ws-a');
		first.show('ide');

		const second = createService();
		assert.strictEqual(second.currentView('ws-a'), 'ide');
		assert.strictEqual(second.currentView('ws-other'), 'agent');
	});
});

suite('Axis view state', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('ignores malformed records', () => {
		const storage = store.add(new TestStorageService());
		const state = new AxisViewState(storage);
		for (const raw of ['{', '[]', 'null', '{"ws":{"view":"split"}}', '{"ws":null}']) {
			storage.store(AXIS_WORKSPACE_VIEWS_STORAGE_KEY, raw, StorageScope.WORKSPACE, 0);
			assert.strictEqual(state.get('perWorkspace', 'ws'), 'agent', raw);
		}
		storage.store(AXIS_GLOBAL_VIEW_STORAGE_KEY, 'split', StorageScope.APPLICATION, 0);
		assert.strictEqual(state.get('global', 'ws'), 'agent');
	});

	test('keeps a bounded number of workspace records, dropping the oldest', () => {
		const storage = store.add(new TestStorageService());
		const state = new AxisViewState(storage);
		for (let i = 0; i <= MAX_WORKSPACE_VIEW_RECORDS; i++) {
			state.set('perWorkspace', `ws-${i}`, 'ide');
		}
		const records = JSON.parse(storage.get(AXIS_WORKSPACE_VIEWS_STORAGE_KEY, StorageScope.WORKSPACE)!);
		assert.strictEqual(Object.keys(records).length, MAX_WORKSPACE_VIEW_RECORDS);
		assert.strictEqual(state.get('perWorkspace', 'ws-0'), 'agent');
		assert.strictEqual(state.get('perWorkspace', `ws-${MAX_WORKSPACE_VIEW_RECORDS}`), 'ide');
	});
});
