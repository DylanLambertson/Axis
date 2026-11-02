import { getService, IWorkbenchLayoutService } from '@codingame/monaco-vscode-api'
import { Parts } from '@codingame/monaco-vscode-views-service-override'
import { useEffect, useState } from 'react'
import * as vscode from 'vscode'
import { PartHost } from './PartHost'
import { startMark } from './vscode/params'

const themes = ['Default Dark Modern', 'Default Light Modern', 'Default High Contrast']

function TopBar() {
  const [theme, setTheme] = useState(0)
  const run = (command: string, ...args: unknown[]) => () => void vscode.commands.executeCommand(command, ...args)

  async function togglePart(part: Parts) {
    const layout = await getService(IWorkbenchLayoutService)
    layout.setPartHidden(layout.isVisible(part, window), part)
  }

  async function cycleTheme() {
    const next = (theme + 1) % themes.length
    await vscode.workspace
      .getConfiguration('workbench')
      .update('colorTheme', themes[next], vscode.ConfigurationTarget.Global)
    setTheme(next)
  }

  return (
    <header className="topbar">
      <span className="brand">Axis</span>
      <span className="workspace">{vscode.workspace.name ?? 'no folder'}</span>
      <button className="search" onClick={run('workbench.action.quickOpen')}>
        Search files, or type &gt; for commands
      </button>
      <nav>
        <button onClick={run('workbench.action.showCommands')}>Commands</button>
        <button onClick={run('workbench.view.search')}>Search</button>
        <button onClick={run('workbench.view.extensions')}>Extensions</button>
        <button onClick={() => void togglePart(Parts.PANEL_PART)}>Panel</button>
        <button onClick={() => void togglePart(Parts.AUXILIARYBAR_PART)}>Agent</button>
        <button onClick={() => void cycleTheme()}>Theme</button>
      </nav>
    </header>
  )
}

export function App() {
  useEffect(() => {
    startMark('axis:shell:mounted')
  }, [])

  return (
    <div className="shell">
      <TopBar />
      <div className="body">
        <PartHost part={Parts.ACTIVITYBAR_PART} className="activitybar" />
        <PartHost part={Parts.SIDEBAR_PART} className="sidebar" />
        <div className="center">
          <PartHost part={Parts.EDITOR_PART} className="editor" />
          <PartHost part={Parts.PANEL_PART} className="panel" />
        </div>
        <PartHost part={Parts.AUXILIARYBAR_PART} className="auxiliarybar" />
      </div>
      <PartHost part={Parts.STATUSBAR_PART} className="statusbar" />
    </div>
  )
}
