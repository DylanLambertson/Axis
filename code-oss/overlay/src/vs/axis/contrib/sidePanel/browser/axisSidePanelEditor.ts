/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Dylan Lambertson. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { IReference, Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorExtensionsRegistry } from '../../../../editor/browser/editorExtensions.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { Selection } from '../../../../editor/common/core/selection.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { KeybindingsRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { AXIS_SIDE_PANEL_EDITOR_FOCUS, AXIS_SIDE_PANEL_LEAVE_WEIGHT, AXIS_SIDE_PANEL_ROUTE_WEIGHT, AXIS_SIDE_PANEL_ROUTED_KEYS, AxisSidePanelCommand, AxisSidePanelCommandId, IAxisSidePanelEditorInput, sidePanelEditorOptions } from '../common/axisSidePanelEditor.js';

/** What the workbench supplies: saving one resource, the hand-off to IDE view, and the user's editor settings. */
export interface IAxisSidePanelEditorHost {
	/** `ITextFileService.save(resource)` in the workbench; never the editor part's active editor. */
	save(resource: URI, skipSaveParticipants: boolean): Promise<void>;
	/** `IAxisViewService.reveal`, which follows `axis.view.mode`. */
	reveal(target: { resource: URI; selection: Selection | undefined }): Promise<void>;
	/** `ITextResourceConfigurationService.getValue(resource, 'editor')`. */
	editorSettings(resource: URI): Readonly<Record<string, unknown>> | undefined;
}

export type AxisSidePanelOpenResult = 'opened' | 'unavailable' | 'superseded' | 'disposed';

/** Editors made by this class, so a command can find the instance from the focused code editor. */
const instances = new WeakMap<ICodeEditor, AxisSidePanelEditor>();

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
			return generation === this.generation && !this._store.isDisposed ? 'unavailable' : 'superseded';
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

	async run(command: AxisSidePanelCommandId): Promise<void> {
		const resource = this.resource;
		if (!resource) {
			return;
		}
		switch (command) {
			case AxisSidePanelCommand.save:
			case AxisSidePanelCommand.saveWithoutFormatting:
				if (this.widget && !this.widget.getOption(EditorOption.readOnly)) {
					await this.hostServices.save(resource, command === AxisSidePanelCommand.saveWithoutFormatting);
				}
				return;
			case AxisSidePanelCommand.openInIde:
				await this.hostServices.reveal({ resource, selection: this.widget?.getSelection() ?? undefined });
				return;
			case AxisSidePanelCommand.close:
				this.close();
				return;
			case AxisSidePanelCommand.leave:
				this.leave();
				return;
		}
	}
}

function focusedInstance(accessor: ServicesAccessor): AxisSidePanelEditor | undefined {
	const editor = accessor.get(ICodeEditorService).getFocusedCodeEditor();
	return editor ? instances.get(editor) : undefined;
}

/**
 * Registers the routed keys and Escape. Each routed key replaces, while the focus is in a side-panel editor, a
 * workbench command that would otherwise act on the editor part's active editor (for Save: save a different file).
 */
export function registerAxisSidePanelEditorKeys(): IDisposable {
	const store = new DisposableStore();
	const when = ContextKeyExpr.equals(AXIS_SIDE_PANEL_EDITOR_FOCUS, true);
	const seen = new Set<string>();
	for (const key of AXIS_SIDE_PANEL_ROUTED_KEYS) {
		const id = seen.has(key.route) ? `${key.route}.${key.upstreamCommand}` : key.route;
		seen.add(key.route);
		store.add(KeybindingsRegistry.registerCommandAndKeybindingRule({
			id, weight: AXIS_SIDE_PANEL_ROUTE_WEIGHT, when, primary: key.primary, win: key.win,
			handler: accessor => focusedInstance(accessor)?.run(key.route),
		}));
	}
	store.add(KeybindingsRegistry.registerCommandAndKeybindingRule({
		id: AxisSidePanelCommand.leave, weight: AXIS_SIDE_PANEL_LEAVE_WEIGHT, when, primary: KeyCode.Escape,
		handler: accessor => focusedInstance(accessor)?.run(AxisSidePanelCommand.leave),
	}));
	return store;
}
