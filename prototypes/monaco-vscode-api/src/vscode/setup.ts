// Initializes the VS Code services once, before React renders. `initialize` may only be called once per page.
import { getService, initialize, LogLevel, type IWorkbenchConstructionOptions } from '@codingame/monaco-vscode-api'
import getConfigurationServiceOverride, {
  initUserConfiguration
} from '@codingame/monaco-vscode-configuration-service-override'
import getDebugServiceOverride from '@codingame/monaco-vscode-debug-service-override'
import getDialogsServiceOverride from '@codingame/monaco-vscode-dialogs-service-override'
import getEnvironmentServiceOverride from '@codingame/monaco-vscode-environment-service-override'
import getExplorerServiceOverride from '@codingame/monaco-vscode-explorer-service-override'
import getExtensionGalleryServiceOverride from '@codingame/monaco-vscode-extension-gallery-service-override'
import getExtensionsServiceOverride from '@codingame/monaco-vscode-extensions-service-override'
import { createIndexedDBProviders } from '@codingame/monaco-vscode-files-service-override'
import getKeybindingsServiceOverride from '@codingame/monaco-vscode-keybindings-service-override'
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override'
import getLifecycleServiceOverride from '@codingame/monaco-vscode-lifecycle-service-override'
import getLogServiceOverride from '@codingame/monaco-vscode-log-service-override'
import getMarkersServiceOverride from '@codingame/monaco-vscode-markers-service-override'
import getModelServiceOverride from '@codingame/monaco-vscode-model-service-override'
import getNotificationsServiceOverride from '@codingame/monaco-vscode-notifications-service-override'
import getOutputServiceOverride from '@codingame/monaco-vscode-output-service-override'
import getPreferencesServiceOverride from '@codingame/monaco-vscode-preferences-service-override'
import getQuickAccessServiceOverride from '@codingame/monaco-vscode-quickaccess-service-override'
import getRemoteAgentServiceOverride from '@codingame/monaco-vscode-remote-agent-service-override'
import getScmServiceOverride from '@codingame/monaco-vscode-scm-service-override'
import getSearchServiceOverride from '@codingame/monaco-vscode-search-service-override'
import getStorageServiceOverride from '@codingame/monaco-vscode-storage-service-override'
import getTerminalServiceOverride from '@codingame/monaco-vscode-terminal-service-override'
import getTextmateServiceOverride from '@codingame/monaco-vscode-textmate-service-override'
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override'
import getStatusBarServiceOverride from '@codingame/monaco-vscode-view-status-bar-service-override'
import getViewsServiceOverride, { isEditorPartVisible } from '@codingame/monaco-vscode-views-service-override'
import getWorkingCopyServiceOverride from '@codingame/monaco-vscode-working-copy-service-override'
import * as vscode from 'vscode'
import 'vscode/localExtensionHost'

// Built-in extensions bundled by monaco-vscode-api as npm packages (grammars, themes, TS language features).
import '@codingame/monaco-vscode-javascript-default-extension'
import '@codingame/monaco-vscode-json-default-extension'
import '@codingame/monaco-vscode-markdown-basics-default-extension'
import '@codingame/monaco-vscode-search-result-default-extension'
import '@codingame/monaco-vscode-theme-defaults-default-extension'
import '@codingame/monaco-vscode-theme-seti-default-extension'
import '@codingame/monaco-vscode-typescript-basics-default-extension'
import '@codingame/monaco-vscode-typescript-language-features-default-extension'

import { remoteAuthority, startMark } from './params'
import { EchoTerminalBackend, NodeTerminalBackend } from './terminal'
import { mountWorkspace } from './workspace'

startMark('axis:setup:start')

const workerUrls: Record<string, URL> = {
  editorWorkerService: new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
  extensionHostWorkerMain: new URL(
    '@codingame/monaco-vscode-api/workers/extensionHost.worker',
    import.meta.url
  ),
  TextMateWorker: new URL('@codingame/monaco-vscode-textmate-service-override/worker', import.meta.url),
  OutputLinkDetectionWorker: new URL('@codingame/monaco-vscode-output-service-override/worker', import.meta.url),
  LocalFileSearchWorker: new URL('@codingame/monaco-vscode-search-service-override/worker', import.meta.url)
}

window.MonacoEnvironment = {
  getWorkerUrl: (_moduleId, label) => workerUrls[label]?.toString() ?? '',
  getWorkerOptions: () => ({ type: 'module' })
}

const userConfiguration = {
  'workbench.colorTheme': 'Default Dark Modern',
  'workbench.iconTheme': 'vs-seti',
  'workbench.sideBar.location': 'left',
  'editor.fontSize': 13,
  'files.autoSave': 'off',
  'extensions.autoUpdate': false,
  'telemetry.telemetryLevel': 'off',
  // DOM renderer, so the smoke script can read terminal output.
  'terminal.integrated.gpuAcceleration': 'off'
}

await createIndexedDBProviders()
await initUserConfiguration(JSON.stringify(userConfiguration, null, 2))
const workspace = await mountWorkspace()

// Web extensions are served from Open VSX (no Microsoft Marketplace; ADR 0002 context fact 5).
const construction: IWorkbenchConstructionOptions = {
  remoteAuthority,
  enableWorkspaceTrust: false,
  developmentOptions: { logLevel: LogLevel.Info },
  workspaceProvider: {
    trusted: true,
    workspace: { folderUri: workspace.folder },
    async open() {
      return false
    }
  },
  defaultLayout: {
    editors: [{ uri: workspace.firstFile, viewColumn: 1 }],
    force: true
  },
  productConfiguration: {
    nameShort: 'Axis Prototype',
    nameLong: 'Axis Prototype (monaco-vscode-api)',
    extensionsGallery: {
      serviceUrl: 'https://open-vsx.org/vscode/gallery',
      resourceUrlTemplate: 'https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}',
      extensionUrlTemplate: 'https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest',
      controlUrl: '',
      nlsBaseUrl: ''
    }
  }
}

await initialize(
  {
    ...getLogServiceOverride(),
    ...getExtensionsServiceOverride({ enableWorkerExtensionHost: true }),
    ...getExtensionGalleryServiceOverride({ webOnly: true }),
    ...getModelServiceOverride(),
    ...getNotificationsServiceOverride(),
    ...getDialogsServiceOverride(),
    ...getConfigurationServiceOverride(),
    ...getKeybindingsServiceOverride(),
    ...getTextmateServiceOverride(),
    ...getThemeServiceOverride(),
    ...getLanguagesServiceOverride(),
    ...getPreferencesServiceOverride(),
    ...getViewsServiceOverride(),
    ...getStatusBarServiceOverride(),
    ...getQuickAccessServiceOverride({
      isKeybindingConfigurationVisible: isEditorPartVisible,
      shouldUseGlobalPicker: (_editor, isStandalone) => !isStandalone && isEditorPartVisible()
    }),
    ...getSearchServiceOverride(),
    ...getExplorerServiceOverride(),
    ...getMarkersServiceOverride(),
    ...getOutputServiceOverride(),
    ...getTerminalServiceOverride(window.axisNode ? new NodeTerminalBackend() : new EchoTerminalBackend()),
    ...getDebugServiceOverride(),
    ...getScmServiceOverride(),
    ...getStorageServiceOverride(),
    ...getLifecycleServiceOverride(),
    ...getEnvironmentServiceOverride(),
    ...getWorkingCopyServiceOverride(),
    ...getRemoteAgentServiceOverride({ scanRemoteExtensions: true })
  },
  document.body,
  construction
)

startMark('axis:services:ready')

// Hook for scripts/smoke.mjs (prototype only): drives the public extension API from the test harness.
window.__axisTest = { vscode, getService }

export { vscode }
