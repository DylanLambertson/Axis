// A React component rendered inside a VS Code view (the reverse direction: React leaf UI hosted by a part).
import { registerCustomView, ViewContainerLocation } from '@codingame/monaco-vscode-views-service-override'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import * as vscode from 'vscode'

function AgentPanel() {
  const [diagnostics, setDiagnostics] = useState(0)
  useEffect(() => {
    const count = () => setDiagnostics(vscode.languages.getDiagnostics().reduce((n, [, d]) => n + d.length, 0))
    count()
    const sub = vscode.languages.onDidChangeDiagnostics(count)
    return () => sub.dispose()
  }, [])
  return (
    <div className="agent-panel">
      <p>React view inside a VS Code part.</p>
      <p>
        Workspace diagnostics: <strong data-testid="diag-count">{diagnostics}</strong>
      </p>
    </div>
  )
}

registerCustomView({
  id: 'axis.agent',
  name: 'Agent',
  location: ViewContainerLocation.AuxiliaryBar,
  renderBody(container) {
    const root = createRoot(container)
    root.render(<AgentPanel />)
    return { dispose: () => root.unmount() }
  }
})
