// Minimal Chrome DevTools Protocol driver for the prototype's smoke checks and measurements.
// No dependencies: uses Node's built-in WebSocket and fetch (Node >= 22).
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export async function launchChrome({ port = 9333, profileDir, headless = true } = {}) {
  const userDataDir = profileDir ?? mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'axis-m4-chrome-'))
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1440,900',
    ...(headless ? ['--headless=new'] : []),
    'about:blank'
  ]
  const child = spawn(CHROME, args, { stdio: 'ignore' })
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const page = targets.find((t) => t.type === 'page')
      if (page) return { child, userDataDir, page: await connect(page.webSocketDebuggerUrl) }
    } catch {
      // not up yet
    }
    await sleep(200)
  }
  child.kill()
  throw new Error('Chrome did not start')
}

/** Launches the prototype's Electron host with DevTools enabled and connects to its window. */
export async function launchElectron({ port = 9340, args = [], env = {} } = {}) {
  // Spawn the Electron binary itself (not the npm wrapper) so killing the child really stops the app.
  const electronDir = new URL('../node_modules/electron/', import.meta.url).pathname
  const electron = join(electronDir, 'dist', readFileSync(join(electronDir, 'path.txt'), 'utf8').trim())
  const child = spawn(electron, [`--remote-debugging-port=${port}`, new URL('../electron/main.cjs', import.meta.url).pathname, ...args], {
    stdio: 'ignore',
    env: { ...process.env, ...env }
  })
  for (let i = 0; i < 150; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
      if (page) return { child, page: await connect(page.webSocketDebuggerUrl) }
    } catch {
      // not up yet
    }
    await sleep(200)
  }
  child.kill()
  throw new Error('Electron did not start')
}

/** Sums RSS (MiB) over a process and all its descendants, the method used for the M2 Code OSS baseline. */
export function treeRssMiB(rootPid) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number))
  const ids = new Set([rootPid])
  for (let grew = true; grew; ) {
    grew = false
    for (const [pid, ppid] of rows) if (ids.has(ppid) && !ids.has(pid)) (ids.add(pid), (grew = true))
  }
  const kib = rows.filter(([pid]) => ids.has(pid)).reduce((n, [, , rss]) => n + rss, 0)
  return { processes: ids.size, rssMiB: Math.round(kib / 1024) }
}

export async function connect(url) {
  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let id = 0
  const pending = new Map()
  const listeners = new Map()
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`))
      else resolve(msg.result)
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id
      pending.set(n, { resolve, reject })
      ws.send(JSON.stringify({ id: n, method, params }))
    })
  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn])

  const page = {
    send,
    on,
    close: () => ws.close(),
    async eval(expression, timeoutMs = 90_000) {
      let timer
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`eval timed out after ${timeoutMs} ms`)), timeoutMs)
      })
      const r = await Promise.race([
        send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
        timeout
      ]).finally(() => clearTimeout(timer))
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      return r.result.value
    },
    async waitFor(expression, timeoutMs = 60_000, intervalMs = 100) {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        try {
          const v = await page.eval(expression, Math.max(1_000, timeoutMs - (Date.now() - start)))
          if (v) return v
        } catch {
          // page may be navigating
        }
        await sleep(intervalMs)
      }
      throw new Error(`timeout waiting for: ${expression}`)
    },
    async screenshot(path) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(path, Buffer.from(data, 'base64'))
    },
    async key(key, { code = key, modifiers = 0, keyCode } = {}) {
      const base = { key, code, modifiers, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    },
    async type(text) {
      await send('Input.insertText', { text })
    },
    async click(x, y) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
      }
    }
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Log.enable')
  return page
}
