// Placeholder for the optional contextual AI panel on the right (docs/UX.md).
import * as React from '@theia/core/shared/react';
import { injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser';

@injectable()
export class AxisAiPanelWidget extends ReactWidget {

    static readonly ID = 'axis-ai-panel';
    static readonly LABEL = 'Axis';

    @postConstruct()
    protected init(): void {
        this.id = AxisAiPanelWidget.ID;
        this.title.label = AxisAiPanelWidget.LABEL;
        this.title.caption = 'Axis AI panel (prototype placeholder)';
        this.title.iconClass = 'codicon codicon-sparkle';
        this.title.closable = true;
        this.addClass('axis-ai-panel');
        this.update();
    }

    protected render(): React.ReactNode {
        return <div className='axis-ai-panel-body'>
            <h3>Composer</h3>
            <p className='axis-secondary'>Ask · Edit · Agent</p>
            <p className='axis-muted'>Placeholder widget contributed by the axis-shell extension.</p>
        </div>;
    }
}
