// Walks the feature checklist in headless Chrome and prints one JSON result per step.
// Usage: node scripts/smoke.mjs [url] [screenshot-dir] [--skip-openvsx]
//        node scripts/smoke.mjs --electron[=dev] <workspace-dir> [screenshot-dir] [--skip-openvsx]
// The browser mode needs the dev server (npm run dev) or a preview of the build (npm run preview).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchChrome, launchElectron, treeRssMiB } from './cdp.mjs'

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const skipOpenVsx = process.argv.includes('--skip-openvsx')
const electronFlag = process.argv.find((a) => a.startsWith('--electron'))
const url = electronFlag ? null : (args[0] ?? 'http://127.0.0.1:5174/')
const shots = args[1] ?? 'smoke-shots'
mkdirSync(shots, { recursive: true })

const { child, page } = electronFlag
  ? await launchElectron({
      args: [...(electronFlag === '--electron=dev' ? ['--dev'] : []), `--workspace=${args[0]}`],
      env: { AXIS_USER_DATA: join(process.env.TMPDIR ?? '/tmp', `axis-m4-electron-${Date.now()}`) }
    })
  : await launchChrome({ port: 9335 })
const errors = []
page.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text))
page.on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error') errors.push(p.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300))
})

const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const diagCount =
  'window.__axisTest.vscode.languages.getDiagnostics().reduce((n, [, d]) => n + d.length, 0)'
const cmd = (id, ...a) => page.eval(`window.__axisTest.vscode.commands.executeCommand(${[id, ...a].map((x) => JSON.stringify(x)).join(',')}).then(() => true)`)
const rows = (sel) => page.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(e => e.textContent.trim()).slice(0, 8)`)

// Starts an Open VSX install, accepts upstream's publisher-trust dialog, and waits for the extension to register.
async function installFromOpenVsx(id) {
  await page.eval(`window.__axisInstall = undefined; void window.__axisTest.vscode.commands.executeCommand('workbench.extensions.installExtension', ${JSON.stringify(id)}).then(() => (window.__axisInstall = 'resolved'), e => (window.__axisInstall = 'rejected: ' + e)); true`)
  // Upstream asks before installing: publisher trust, and a "limited functionality in the web" notice.
  const prompts = []
  const start = Date.now()
  while (Date.now() - start < 120_000) {
    const clicked = await page.eval(
      "(b => b ? (b.click(), b.textContent) : null)([...document.querySelectorAll('.monaco-dialog-box .monaco-button')].find(b => /Trust Publisher|Install Anyway/.test(b.textContent)))"
    )
    if (clicked && prompts.at(-1) !== clicked) prompts.push(clicked)
    const state = await page.eval('window.__axisInstall')
    if (state === 'resolved') return { promptsAccepted: prompts }
    if (state) throw new Error(state)
    await sleep(250)
  }
  throw new Error('install did not finish in 120 s')
}

async function step(name, fn) {
  const t0 = Date.now()
  try {
    const evidence = await fn()
    results.push({ step: name, ok: true, ms: Date.now() - t0, evidence })
  } catch (error) {
    results.push({ step: name, ok: false, ms: Date.now() - t0, error: String(error.message ?? error).slice(0, 400) })
  }
  await page.screenshot(join(shots, `${String(results.length).padStart(2, '0')}-${name}.png`)).catch(() => {})
}

async function jsMemoryMiB() {
  return page.eval(`crossOriginIsolated && performance.measureUserAgentSpecificMemory
    ? performance.measureUserAgentSpecificMemory().then(m => Math.round(m.bytes / 1048576))
    : 'unavailable (not cross-origin isolated)'`).catch((e) => `unavailable: ${String(e.message).split('\n')[0]}`)
}

try {
  const nav = Date.now()
  if (url) await page.send('Page.navigate', { url })
  await step('load', async () => {
    await page.waitFor("window.__axisMarks && window.__axisMarks['axis:shell:mounted']", 180_000)
    return { wallMs: Date.now() - nav, marks: await page.eval('window.__axisMarks') }
  })
  const root = await page.eval("window.axisNode?.workspacePath ?? '/workspace'")
  await step('explorer', async () => {
    await page.waitFor("document.querySelectorAll('.explorer-folders-view .monaco-list-row').length >= 4", 20_000)
    return rows('.explorer-folders-view .monaco-list-row')
  })
  await step('ts-diagnostics', async () => {
    await page.waitFor(`${diagCount} === 2`, 60_000)
    return {
      sinceNavigationMs: Date.now() - nav,
      messages: await page.eval(
        'window.__axisTest.vscode.languages.getDiagnostics().flatMap(([u, d]) => d.map(x => u.path + ":" + (x.range.start.line + 1) + " " + x.source + " " + x.message))'
      )
    }
  })
  await step('memory-after-startup', async () => ({ jsHeapMiB: await jsMemoryMiB(), processTree: treeRssMiB(child.pid) }))
  await step('edit-and-save', async () => {
    await cmd('workbench.action.focusActiveEditorGroup')
    await cmd('cursorBottom')
    await page.type("const extra: number = 'not a number'\n")
    // The Problems badge reflects the markers service; the extension API count is recorded separately.
    await page.waitFor("document.querySelector('.part.panel .badge-content')?.textContent === '3'", 30_000)
    const apiDiagnostics = await page.eval(
      'window.__axisTest.vscode.languages.getDiagnostics().flatMap(([u, d]) => d.map(x => u.toString() + ":" + (x.range.start.line + 1) + " ts" + x.code))'
    )
    const dirty = await page.eval('window.__axisTest.vscode.window.activeTextEditor.document.isDirty')
    await cmd('workbench.action.files.save')
    const saved = await page.eval(
      `window.__axisTest.vscode.workspace.fs.readFile(window.__axisTest.vscode.Uri.file('${root}/src/index.ts')).then(b => new TextDecoder().decode(b).includes('const extra'))`
    )
    return { problemsBadge: 3, apiDiagnostics, dirtyBeforeSave: dirty, savedContentHasEdit: saved }
  })
  await step('quick-open-files', async () => {
    await cmd('workbench.action.quickOpen', 'math')
    await page.waitFor("document.querySelectorAll('.quick-input-widget .monaco-list-row').length > 0", 15_000)
    const r = await rows('.quick-input-widget .monaco-list-row')
    await page.key('Escape', { keyCode: 27 })
    return r
  })
  await step('command-palette-F1', async () => {
    await page.key('F1', { keyCode: 112 })
    await page.waitFor("document.querySelector('.quick-input-widget') && getComputedStyle(document.querySelector('.quick-input-widget')).display !== 'none'", 10_000)
    await page.type('toggle panel')
    await sleep(500)
    const r = await rows('.quick-input-widget .monaco-list-row')
    await page.key('Escape', { keyCode: 27 })
    return r
  })
  await step('search', async () => {
    await cmd('workbench.action.findInFiles', { query: 'add', triggerSearch: true })
    await page.waitFor("document.querySelectorAll('.search-view .monaco-list-row').length > 0", 20_000)
    return {
      message: await page.eval("document.querySelector('.search-view .messages')?.textContent?.trim() ?? ''"),
      rows: await rows('.search-view .monaco-list-row')
    }
  })
  await step('react-view-in-auxiliarybar', async () => {
    await cmd('workbench.action.toggleAuxiliaryBar')
    const api = await page.eval(diagCount)
    const text = await page.waitFor(`(t => t === String(${api}) && t)(document.querySelector('[data-testid=diag-count]')?.textContent)`, 10_000)
    return { diagnosticsShownByReact: text, extensionApiCount: api }
  })
  await step('builtin-theme-light', async () => {
    await page.eval("window.__axisTest.vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Default Light Modern', 1).then(() => true)")
    await page.waitFor("document.body.classList.contains('vs') && !document.body.classList.contains('vs-dark')", 10_000)
    return { bodyClass: await page.eval('document.body.className') }
  })
  await step('terminal', async () => {
    await cmd('workbench.action.terminal.focus')
    await sleep(500)
    await page.type('echo hi-$((40+2))')
    await page.key('Enter', { keyCode: 13 })
    await sleep(1000)
    const screen = await page.eval("[...document.querySelectorAll('.xterm-rows > div')].map(r => r.textContent.trimEnd()).filter(Boolean).join(' | ')")
    return {
      terminals: await page.eval('window.__axisTest.vscode.window.terminals.map(t => t.name)'),
      screen,
      shellEvaluated: /(^|[^$(])hi-42/.test(screen)
    }
  })
  await step('scm-view', async () => {
    await cmd('workbench.view.scm')
    await sleep(800)
    return page.eval("document.querySelector('.part.sidebar')?.innerText?.slice(0, 200)")
  })
  await step('debug-view', async () => {
    await cmd('workbench.view.debug')
    await sleep(800)
    return page.eval("document.querySelector('.part.sidebar')?.innerText?.slice(0, 300)")
  })

  if (!skipOpenVsx) {
    await step('openvsx-install-theme', async () => {
      const t = Date.now()
      const install = await installFromOpenVsx('dracula-theme.theme-dracula')
      await page.eval("window.__axisTest.vscode.workspace.getConfiguration('workbench').update('colorTheme', 'Dracula Theme', 1).then(() => true)")
      await page.waitFor("[...document.body.classList].some(c => c.includes('dracula'))", 30_000)
      return { ...install, installMs: Date.now() - t, bodyClass: await page.eval('document.body.className') }
    })
    await step('openvsx-install-prettier-web', async () => {
      const t = Date.now()
      const install = await installFromOpenVsx('esbenp.prettier-vscode')
      const installMs = Date.now() - t
      await page.eval("window.__axisTest.vscode.workspace.getConfiguration().update('[typescript]', { 'editor.defaultFormatter': 'esbenp.prettier-vscode' }, 1).then(() => true)")
      await page.eval(`window.__axisTest.vscode.window.showTextDocument(window.__axisTest.vscode.Uri.file('${root}/src/messy.ts')).then(() => true)`)
      // Prettier activates on startup finished and registers its provider asynchronously; poll the provider API
      // (no dialog) until it answers, then run the user-facing format command.
      const edits = await page.waitFor(
        `window.__axisTest.vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', window.__axisTest.vscode.Uri.file('${root}/src/messy.ts')).then(e => e && e.length ? e.map(x => x.newText).join('') : null)`,
        60_000,
        1_000
      )
      const providerReadyMs = Date.now() - t
      await cmd('editor.action.formatDocument')
      const text = await page.waitFor(
        "(t => t.includes('\"hello\";') && t)(window.__axisTest.vscode.window.activeTextEditor.document.getText())",
        30_000
      )
      return { ...install, installMs, providerReadyMs, providerEditPreview: edits.slice(0, 120), formatted: text }
    })
  }
  await step('memory-after-checklist', async () => ({ jsHeapMiB: await jsMemoryMiB(), processTree: treeRssMiB(child.pid) }))
} finally {
  for (const r of results) console.log(JSON.stringify(r))
  console.log(JSON.stringify({ consoleErrors: errors.length, firstErrors: errors.slice(0, 15) }))
  page.close()
  child.kill()
}
