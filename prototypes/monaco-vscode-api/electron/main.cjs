// Electron host for the prototype. The renderer runs the same web build as the browser; Node-only capabilities
// (real file system, a pipe-backed shell) are offered through a narrow, validated IPC surface in preload.cjs.
// There is no Code OSS `reh` server here, so there is no Node extension host, pty, debugger or Git.
//
// Usage:
//   electron electron/main.cjs --dev [--workspace=<dir>]   loads the Vite dev server (npm run dev)
//   electron electron/main.cjs [--workspace=<dir>]         loads dist/ through the axis:// protocol
// Measurement env: AXIS_SHOT=<png> saves a screenshot, AXIS_EXIT_AFTER_MS=<n> quits after measuring.
const t0 = process.hrtime.bigint()
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const dev = process.argv.includes('--dev')
const workspaceArg = process.argv.find((a) => a.startsWith('--workspace='))
const workspaceRoot = path.resolve(workspaceArg ? workspaceArg.slice('--workspace='.length) : process.cwd())
const distDir = path.join(__dirname, '..', 'dist')

// The prototype runs with its own profile so it never touches a real Electron or VS Code profile.
if (process.env.AXIS_USER_DATA) app.setPath('userData', path.resolve(process.env.AXIS_USER_DATA))

protocol.registerSchemesAsPrivileged([
  { scheme: 'axis', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }
])

const isolationHeaders = {
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'cross-origin'
}

/** Resolves a renderer-supplied path and rejects anything outside the opened folder. */
function inWorkspace(p) {
  if (typeof p !== 'string') throw new Error('EINVAL: path must be a string')
  const resolved = path.resolve(p)
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + path.sep)) {
    throw new Error(`EACCES: outside workspace: ${p}`)
  }
  return resolved
}

function kind(stat) {
  return stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'unknown'
}

function registerIpc(win) {
  // Only the prototype's own window may call these handlers.
  const guard = (handler) => (event, ...args) => {
    if (event.sender !== win.webContents) throw new Error('EACCES: unknown sender')
    return handler(...args)
  }
  ipcMain.handle('fs:stat', guard(async (p) => {
    const s = await fs.lstat(inWorkspace(p))
    return { type: kind(s), size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs }
  }))
  ipcMain.handle('fs:readdir', guard(async (p) =>
    (await fs.readdir(inWorkspace(p), { withFileTypes: true })).map((d) => [
      d.name,
      d.isFile() ? 'file' : d.isDirectory() ? 'directory' : d.isSymbolicLink() ? 'symlink' : 'unknown'
    ])
  ))
  ipcMain.handle('fs:readFile', guard(async (p) => new Uint8Array(await fs.readFile(inWorkspace(p)))))
  ipcMain.handle('fs:writeFile', guard(async (p, content) => {
    if (!(content instanceof Uint8Array)) throw new Error('EINVAL: content must be bytes')
    await fs.writeFile(inWorkspace(p), content)
  }))
  ipcMain.handle('fs:mkdir', guard((p) => fs.mkdir(inWorkspace(p))))
  ipcMain.handle('fs:delete', guard((p, recursive) => fs.rm(inWorkspace(p), { recursive: recursive === true })))
  ipcMain.handle('fs:rename', guard((from, to) => fs.rename(inWorkspace(from), inWorkspace(to))))

  const shells = new Map()
  let nextId = 1
  ipcMain.handle('shell:spawn', guard((cwd) => {
    const id = nextId++
    const child = spawn('/bin/sh', [], { cwd: inWorkspace(cwd), env: { ...process.env, PS1: '' } })
    shells.set(id, child)
    const forward = (chunk) => win.webContents.send('shell:data', id, chunk.toString('utf8'))
    child.stdout.on('data', forward)
    child.stderr.on('data', forward)
    child.on('exit', (code) => {
      shells.delete(id)
      if (!win.isDestroyed()) win.webContents.send('shell:exit', id, code)
    })
    return id
  }))
  ipcMain.on('shell:write', (event, id, data) => {
    if (event.sender === win.webContents && typeof data === 'string') shells.get(id)?.stdin.write(data)
  })
  ipcMain.on('shell:kill', (event, id) => {
    if (event.sender === win.webContents) shells.get(id)?.kill()
  })
  app.on('will-quit', () => shells.forEach((c) => c.kill()))
}

/** Sums RSS over the Electron main process and all its descendants, like the M2 Code OSS measurement. */
function treeRssMiB() {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .map(([pid, ppid, rss, ...comm]) => ({ pid: +pid, ppid: +ppid, rss: +rss, comm: comm.join(' ') }))
  const ids = new Set([process.pid])
  let grew = true
  while (grew) {
    grew = false
    for (const r of rows) if (ids.has(r.ppid) && !ids.has(r.pid)) (ids.add(r.pid), (grew = true))
  }
  const procs = rows.filter((r) => ids.has(r.pid))
  return {
    totalMiB: Math.round(procs.reduce((n, r) => n + r.rss, 0) / 1024),
    processes: procs.map((r) => `${path.basename(r.comm)}=${Math.round(r.rss / 1024)}MiB`)
  }
}

app.whenReady().then(async () => {
  protocol.handle('axis', async (request) => {
    const { pathname } = new URL(request.url)
    const file = path.normalize(path.join(distDir, decodeURIComponent(pathname)))
    if (!file.startsWith(distDir + path.sep)) return new Response('forbidden', { status: 403 })
    const response = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(response.headers)
    for (const [k, v] of Object.entries(isolationHeaders)) headers.set(k, v)
    return new Response(response.body, { status: response.status, headers })
  })

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: !process.env.AXIS_EXIT_AFTER_MS,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [`--axis-workspace=${workspaceRoot}`]
    }
  })
  registerIpc(win)
  // Block in-window navigation away from the app and new windows (extension links open nowhere in the prototype).
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(dev ? 'http://127.0.0.1:5174/' : 'axis://app/')) e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  await win.loadURL(dev ? 'http://127.0.0.1:5174/' : 'axis://app/index.html')

  if (process.env.AXIS_EXIT_AFTER_MS) {
    const mounted = await waitFor(win, "window.__axisMarks && window.__axisMarks['axis:shell:mounted']", 180_000)
    const startupMs = Number((process.hrtime.bigint() - t0) / 1_000_000n)
    const diagnosticsReady = await waitFor(win, 'document.querySelector(".part.statusbar")?.innerText.includes("2")', 60_000)
    const diagMs = Number((process.hrtime.bigint() - t0) / 1_000_000n)
    await new Promise((r) => setTimeout(r, Number(process.env.AXIS_EXIT_AFTER_MS)))
    const metrics = app.getAppMetrics().map((m) => `${m.type}=${Math.round(m.memory.workingSetSize / 1024)}MiB`)
    if (process.env.AXIS_SHOT) {
      const image = await win.webContents.capturePage()
      await fs.writeFile(process.env.AXIS_SHOT, image.toPNG())
    }
    const marks = await win.webContents.executeJavaScript('window.__axisMarks')
    console.log(JSON.stringify({ mode: dev ? 'dev' : 'dist', electron: process.versions.electron, mainToShellMountedMs: startupMs, mounted: !!mounted, mainToDiagnosticsMs: diagnosticsReady ? diagMs : null, rendererMarks: marks, rss: treeRssMiB(), appMetricsWorkingSet: metrics }))
    app.quit()
  }
})

async function waitFor(win, expression, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await win.webContents.executeJavaScript(`!!(${expression})`).catch(() => false)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

app.on('window-all-closed', () => app.quit())
