// Mounts the Axis top bar and sets the first-run layout:
// explorer left, terminal bottom, Axis AI panel right (collapsed).
import { inject, injectable } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry } from '@theia/core/lib/common';
import { ApplicationShell, FrontendApplication, FrontendApplicationContribution, WidgetManager } from '@theia/core/lib/browser';
import { AxisTopBarWidget } from './axis-top-bar-widget';
import { AxisAiPanelWidget } from './axis-ai-panel-widget';
import { AxisCommands } from './axis-commands';

@injectable()
export class AxisShellContribution implements FrontendApplicationContribution, CommandContribution {

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(AxisTopBarWidget)
    protected readonly topBar: AxisTopBarWidget;

    onStart(_app: FrontendApplication): void {
        // The top panel is not part of the persisted layout, so add it on every start.
        this.shell.addWidget(this.topBar, { area: 'top' });
        this.shell.addClass('axis-shell');
    }

    async initializeLayout(_app: FrontendApplication): Promise<void> {
        // Runs only when no layout was restored (first start or reset layout).
        const ai = await this.widgetManager.getOrCreateWidget(AxisAiPanelWidget.ID);
        await this.shell.addWidget(ai, { area: 'right', rank: 100 });
        this.shell.collapsePanel('right');
    }

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(AxisCommands.TOGGLE_AI_PANEL, {
            execute: async () => {
                const ai = await this.widgetManager.getOrCreateWidget(AxisAiPanelWidget.ID);
                if (!ai.isAttached) {
                    await this.shell.addWidget(ai, { area: 'right', rank: 100 });
                }
                if (this.shell.isExpanded('right') && ai.isVisible) {
                    this.shell.collapsePanel('right');
                } else {
                    await this.shell.activateWidget(ai.id);
                }
            }
        });
    }
}
