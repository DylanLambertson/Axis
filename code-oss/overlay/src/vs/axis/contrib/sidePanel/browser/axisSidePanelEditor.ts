/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { IReference, Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorExtensionsRegistry } from '../../../../editor/browser/editorExtensions.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { Selection } from '../../../../editor/common/core/selection.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { CommandsRegistry, ICommand, ICommandHandler } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { KeybindingsRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { AXIS_SIDE_PANEL_COMMAND_POLICY, AXIS_SIDE_PANEL_EDITOR_FOCUS, AXIS_SIDE_PANEL_LEAVE_COMMAND, AXIS_SIDE_PANEL_LEAVE_WEIGHT, AxisSidePanelAction, guardDecision, hasExplicitTarget, IAxisSidePanelEditorInput, sidePanelEditorOptions } from '../common/axisSidePanelEditor.js';

/** What the workbench supplies: saving one resource, the hand-off to IDE view, and the user's editor settings. */
export interface IAxisSidePanelEditorHost {
	/** `ITextFileService.save(resource)` in the workbench; never the editor part's active editor. */
	save(resource: URI, skipSaveParticipants: boolean): Promise<void>;
	/** `IAxisViewService.reveal`, which follows `axis.view.mode`. */
	reveal(target: { resource: URI; selection: Selection | undefined }): Promise<void>;
	/** `ITextResourceConfigurationService.getValue(resource, 'editor')`. */
	editorSettings(resource: URI): Readonly<Record<string, unknown>> | undefined;
	/** `ITextFileService.isDirty(resource)`. */
	isDirty(resource: URI): boolean;
	/** Says that a guarded command does nothing in the side panel (a status message in the workbench). */
	blocked(commandId: string): void;
	/** The side-panel editor lost focus: the workbench saves when `files.autoSave` is `onFocusChange` for `resource`. */
	focusLost(resource: URI): void;
	/**
	 * False when `files.saveConflictResolution` is `overwriteFileOnDisk` for `resource` (review r2 S2): a save would
	 * then overwrite a newer write on disk without asking, so the side panel refuses to save.
	 */
	saveConflictsDetected(resource: URI): boolean;
}

export type AxisSidePanelOpenResult = 'opened' | 'unavailable' | 'superseded' | 'disposed';

/** Editors made by this class, so a command can find the instance from the focused code editor. */
const instances = new WeakMap<ICodeEditor, AxisSidePanelEditor>();
/** Live instances, for Save All. */
const live = new Set<AxisSidePanelEditor>();

/**
 * Spike PV-V0 (docs/design/pv-v0-editor-embed.md): a real `CodeEditorWidget` in an Axis part, over the same text
 * model as IDE view. The model comes from `ITextModelService.createModelReference`, which for `file:` resolves the
 * one `TextFileEditorModel` the IDE editor also uses, so dirty state, undo (keyed by resource) and markers are
 * shared; the reference is held while the file is shown and released on close or dispose. The container gets its own
 * scoped context key, `axisSidePanelEditorFocus`, so keys typed inside it can be routed away from workbench commands
 * that act on the editor part's active editor.
 */
export class AxisSidePanelEditor extends Disposable {

	readonly element: HTMLElement;
	private readonly host: HTMLElement;
	private readonly instantiation: IInstantiationService;
	private widget: CodeEditorWidget | undefined;
	private readonly reference = this._register(new MutableDisposable<IReference<IResolvedTextEditorModel>>());
	private resource: URI | undefined;
	private returnFocus: HTMLElement | undefined;
	private generation = 0;

	constructor(
		private readonly hostServices: IAxisSidePanelEditorHost,
		@IInstantiationService instantiationService: IInstantiationService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this.element = $('.axis-side-editor');
		this.host = append(this.element, $('.axis-side-editor-host'));
		const scoped = this._register(contextKeyService.createScoped(this.element));
		scoped.createKey(AXIS_SIDE_PANEL_EDITOR_FOCUS, true);
		this.instantiation = this._register(instantiationService.createChild(new ServiceCollection([IContextKeyService, scoped])));
		live.add(this);
		this._register({ dispose: () => live.delete(this) });
	}

	get currentResource(): URI | undefined {
		return this.resource;
	}

	get editor(): ICodeEditor | undefined {
		return this.widget;
	}

	/**
	 * Shows `resource`. A later call supersedes an earlier one still resolving: the earlier reference is released
	 * and never shown. `returnFocus` is where Escape (when no editor widget wants it) and Close send the focus.
	 */
	async open(resource: URI, input: IAxisSidePanelEditorInput, returnFocus?: HTMLElement): Promise<AxisSidePanelOpenResult> {
		const generation = ++this.generation;
		let reference: IReference<IResolvedTextEditorModel>;
		try {
			reference = await this.textModelService.createModelReference(resource);
		} catch {
			return this._store.isDisposed ? 'disposed' : generation === this.generation ? 'unavailable' : 'superseded';
		}
		if (this._store.isDisposed) {
			reference.dispose();
			return 'disposed';
		}
		if (generation !== this.generation) {
			reference.dispose();
			return 'superseded';
		}
		const options = sidePanelEditorOptions(this.hostServices.editorSettings(resource), input);
		if (!this.widget) {
			this.widget = this._register(this.instantiation.createInstance(CodeEditorWidget, this.host, options, {
				contributions: EditorExtensionsRegistry.getEditorContributions(),
				isSimpleWidget: false, // a real text editor: extensions see it, as they see the IDE editor of the same document
			}));
			instances.set(this.widget, this);
			const widget = this.widget;
			this._register(widget.onDidBlurEditorWidget(() => {
				const shown = this.resource;
				if (shown) {
					this.hostServices.focusLost(shown);
				}
			}));
		} else {
			this.widget.updateOptions(options);
		}
		this.widget.setModel(reference.object.textEditorModel);
		this.reference.value = reference; // releases the previous file's reference
		this.resource = resource;
		this.returnFocus = returnFocus;
		return 'opened';
	}

	/** Hides the file and releases the model reference; the model lives on while IDE view (or a dirty copy) holds it. */
	close(): void {
		this.generation++;
		this.widget?.setModel(null);
		this.reference.clear();
		this.resource = undefined;
		this.leave();
	}

	/** Moves the focus back to where the file was opened from. */
	leave(): void {
		const target = this.returnFocus;
		if (target?.isConnected) {
			target.focus();
		}
	}

	focus(): void {
		this.widget?.focus();
	}

	layout(width: number, height: number): void {
		this.widget?.layout({ width, height });
	}

	/** Applies a guarded command's action (or `leave`) to the shown file. */
	async run(action: AxisSidePanelAction | 'leave', commandId = ''): Promise<void> {
		const resource = this.resource;
		if (!resource) {
			return;
		}
		switch (action) {
			case 'save':
			case 'saveWithoutFormatting':
				if (!this.hostServices.saveConflictsDetected(resource)) {
					this.hostServices.blocked('files.saveConflictResolution');
					return;
				}
				if (!this.readOnly()) {
					await this.hostServices.save(resource, action === 'saveWithoutFormatting');
				}
				return;
			case 'saveAllToo':
				if (this.readOnly() || !this.hostServices.isDirty(resource)) {
					return;
				}
				// Refused like Save, and said so: a silent skip would let the user believe the file was saved (review r3 N4).
				if (!this.hostServices.saveConflictsDetected(resource)) {
					this.hostServices.blocked('files.saveConflictResolution');
					return;
				}
				await this.hostServices.save(resource, false);
				return;
			case 'openInIde':
				await this.hostServices.reveal({ resource, selection: this.widget?.getSelection() ?? undefined });
				return;
			case 'close':
				this.close();
				return;
			case 'block':
				this.hostServices.blocked(commandId);
				return;
			case 'leave':
				this.leave();
				return;
			case 'accept':
				return;
		}
	}

	private readOnly(): boolean {
		return !this.widget || this.widget.getOption(EditorOption.readOnly);
	}
}

function focusedInstance(accessor: ServicesAccessor): AxisSidePanelEditor | undefined {
	const editor = accessor.get(ICodeEditorService).getFocusedCodeEditor();
	return editor ? instances.get(editor) : undefined;
}

export interface IAxisSidePanelRegistration extends IDisposable {
	/** Command ids now guarded. */
	readonly guarded: readonly string[];
	/** Policy ids with no command registered yet; each is guarded as soon as it registers. */
	readonly missing: readonly string[];
}

/**
 * Registers Escape and the command guards (review S1). Each policy command other than `accept` is re-registered
 * under its own id with a guard: while a side-panel editor has focus and the command has no explicit target, the
 * policy action runs on that editor's file; otherwise the handler under the guard runs.
 *
 * A later registration of a policy id (a command registered at runtime, or an extension registering the same id)
 * would sit on top of the guard (review r2 N1). `CommandsRegistry.registerCommand` is therefore wrapped while this
 * registration lives: a policy id gets its guard stacked over it at once, and the disposable it returns removes that
 * guard with it, so no guard outlives the handler it calls (review r3 N1). Guards are registered through the
 * unwrapped method, so a guard is never guarded again (review r3 N3). Disposing restores the method and the originals.
 */
export function registerAxisSidePanelEditorCommands(): IAxisSidePanelRegistration {
	const store = new DisposableStore();
	const guards = new WeakSet<ICommandHandler>();
	const registry = CommandsRegistry as { registerCommand: typeof CommandsRegistry.registerCommand };
	const register = registry.registerCommand;
	const registerRaw = (command: ICommand): IDisposable => register.call(CommandsRegistry, command);
	store.add(KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: AXIS_SIDE_PANEL_LEAVE_COMMAND, weight: AXIS_SIDE_PANEL_LEAVE_WEIGHT, when: ContextKeyExpr.equals(AXIS_SIDE_PANEL_EDITOR_FOCUS, true), primary: KeyCode.Escape,
		handler: accessor => focusedInstance(accessor)?.run('leave'),
	}));
	const policyAction = (id: string): AxisSidePanelAction | undefined => {
		const action = AXIS_SIDE_PANEL_COMMAND_POLICY.get(id);
		return action === 'accept' ? undefined : action;
	};
	/** Stacks a guard over `original` (the top registration of its id) and returns the guard's own registration. */
	const guard = (original: ICommand, action: AxisSidePanelAction): IDisposable => {
		const id = original.id;
		const handler: ICommandHandler = (accessor, ...args) => {
			const instance = focusedInstance(accessor);
			const decision = guardDecision(action, instance !== undefined, hasExplicitTarget(args));
			if (decision === undefined) {
				return original.handler(accessor, ...args);
			}
			if (decision === 'saveAllToo') {
				return Promise.resolve(original.handler(accessor, ...args)).then(() => Promise.all([...live].map(editor => editor.run('saveAllToo', id))));
			}
			return instance?.run(decision, id);
		};
		guards.add(handler);
		return registerRaw({ id, metadata: original.metadata, handler });
	};
	for (const id of AXIS_SIDE_PANEL_COMMAND_POLICY.keys()) {
		const action = policyAction(id);
		const original = CommandsRegistry.getCommand(id);
		if (action && original) {
			store.add(guard(original, action));
		}
	}
	let wrapped = true;
	const wrapper = function (idOrCommand: string | ICommand, handler?: ICommandHandler): IDisposable {
		// The string form is made a command here, so the guard does not depend on how the registry's own string form
		// reaches its object form (at the pin it calls `this.registerCommand` again, which is this wrapper).
		const command = typeof idOrCommand === 'string' && handler ? { id: idOrCommand, handler } : idOrCommand;
		if (typeof command === 'string') {
			throw new Error('invalid command'); // what the registry throws for an id without a handler
		}
		const inner = registerRaw(command);
		const action = wrapped ? policyAction(command.id) : undefined;
		if (!action) {
			return inner;
		}
		const outer = store.add(guard(command, action));
		return toDisposable(() => {
			store.delete(outer);
			inner.dispose();
		});
	} as typeof CommandsRegistry.registerCommand;
	registry.registerCommand = wrapper;
	store.add(toDisposable(() => {
		wrapped = false;
		if (registry.registerCommand === wrapper) {
			registry.registerCommand = register;
		}
	}));
	const policyIds = [...AXIS_SIDE_PANEL_COMMAND_POLICY.keys()].filter(id => policyAction(id) !== undefined);
	return {
		get guarded() { return policyIds.filter(id => { const top = CommandsRegistry.getCommand(id); return top !== undefined && guards.has(top.handler); }); },
		get missing() { return policyIds.filter(id => !CommandsRegistry.getCommand(id)); },
		dispose: () => store.dispose(),
	};
}
