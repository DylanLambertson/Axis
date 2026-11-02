// Compact Axis top bar (docs/UX.md "Default layout"): workspace switcher,
// command/search, agent activity indicator and account/model control.
// A plain Theia ReactWidget mounted in the shell's top panel.
import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser';
import { CommandService } from '@theia/core/lib/common';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { AxisCommands } from './axis-commands';

@injectable()
export class AxisTopBarWidget extends ReactWidget {

    static readonly ID = 'axis-top-bar';

    @inject(CommandService)
    protected readonly commands: CommandService;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    protected workspaceName = 'No folder';

    @postConstruct()
    protected init(): void {
        this.id = AxisTopBarWidget.ID;
        this.addClass('axis-top-bar');
        this.title.label = 'Axis top bar';
        this.toDispose.push(this.workspaceService.onWorkspaceChanged(() => this.updateWorkspaceName()));
        this.updateWorkspaceName();
    }

    protected updateWorkspaceName(): void {
        const ws = this.workspaceService.workspace;
        this.workspaceName = ws ? ws.resource.path.base : 'No folder';
        this.update();
    }

    protected run(id: string): void {
        this.commands.executeCommand(id);
    }

    protected render(): React.ReactNode {
        return <div className='axis-top-bar-row' role='toolbar' aria-label='Axis top bar'>
            <span className='axis-mark' aria-hidden='true'>◆</span>
            <button type='button' className='axis-chip axis-workspace' title='Switch workspace'
                onClick={() => this.run('workspace:openRecent')}>
                <span className='codicon codicon-repo' aria-hidden='true' /> {this.workspaceName}
                <span className='codicon codicon-chevron-down' aria-hidden='true' />
            </button>
            <button type='button' className='axis-search' title='Search files and commands'
                onClick={() => this.run('workbench.action.showCommands')}>
                <span className='codicon codicon-search' aria-hidden='true' />
                <span className='axis-search-label'>Search or run a command</span>
            </button>
            <div className='axis-spacer' />
            <button type='button' className='axis-chip axis-agents' title='Agent activity'
                onClick={() => this.run(AxisCommands.TOGGLE_AI_PANEL.id)}>
                <span className='axis-dot' aria-hidden='true' /> Agents: idle
            </button>
            <button type='button' className='axis-chip axis-account' title='Account and model'
                onClick={() => this.run(AxisCommands.TOGGLE_AI_PANEL.id)}>
                <span className='codicon codicon-account' aria-hidden='true' /> Model: not configured
            </button>
        </div>;
    }
}
