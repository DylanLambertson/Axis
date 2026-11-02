// Axis shell customisation for the Theia prototype (Phase 0 M4, option C).
// Everything here is an additive contribution: no Theia package is patched.
import { ContainerModule } from '@theia/core/shared/inversify';
import { CommandContribution } from '@theia/core/lib/common';
import { FrontendApplicationContribution, WidgetFactory } from '@theia/core/lib/browser';
import { AxisTopBarWidget } from './axis-top-bar-widget';
import { AxisAiPanelWidget } from './axis-ai-panel-widget';
import { AxisShellContribution } from './axis-shell-contribution';
import { AxisThemeContribution } from './axis-theme';
import '../../src/browser/style/axis.css';

export default new ContainerModule(bind => {
    bind(AxisTopBarWidget).toSelf().inSingletonScope();
    bind(AxisAiPanelWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: AxisAiPanelWidget.ID,
        createWidget: () => ctx.container.get(AxisAiPanelWidget)
    })).inSingletonScope();

    bind(AxisShellContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(AxisShellContribution);
    bind(CommandContribution).toService(AxisShellContribution);

    bind(AxisThemeContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(AxisThemeContribution);
});
