// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Runs a BUILT preload (CommonJS, as scripts/bundle.mjs builds it) in node:vm with a fake `electron`, a fake `window` and the
// globals a sandboxed preload really has (timers included, driven by the harness), calls every exposed function with a wide set
// of hostile arguments, drains microtasks and timers after every step, and lists every way it departs from the contract.
// preloadTextProblems is the second, textual layer. Used by preload-pin.test.mjs on the real preload and on known-bad edits.
import { build } from "esbuild";
import { createContext, runInContext } from "node:vm";
import { join } from "node:path";
import { IPC_CHANNELS, IPC_REPLY_CHANNELS, PRELOAD_FUNCTIONS, PRELOAD_GLOBAL } from "@axis/desktop-main";

export const PAGE_ORIGIN = "axis-app://shell";

/** Builds preload source text exactly as the bundle does (esbuild, node, cjs, electron external). */
export async function buildPreload(contents, resolveDir) {
  const r = await build({
    stdin: { contents, resolveDir, loader: "ts", sourcefile: "preload.ts" },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    logLevel: "silent",
  });
  return r.outputFiles[0].text;
}

const getterObject = () => Object.defineProperty({}, "x", { get: () => "evil:channel", enumerable: true });
/** Every kind of value a page can pass through contextBridge, and some it cannot (the preload must not care). */
export const HOSTILE = [
  "evil:channel",
  "axis:projectAction",
  "x".repeat(100_000),
  "",
  0,
  1,
  -1,
  2 ** 53,
  Number.NaN,
  Infinity,
  1n,
  true,
  null,
  undefined,
  Symbol("evil:channel"),
  [],
  ["evil:channel"],
  { toString: () => "evil:channel" },
  getterObject(),
  Object.create(null),
  () => "evil:channel",
  new Proxy({}, { get: () => "evil:channel" }),
];
const VALID = { nonce: "n0", action: "status", terminalId: "t1", url: "https://example.com/" };

/** A timer queue the harness runs; delays are ignored, order is kept, intervals run a few times. */
function fakeTimers() {
  const queue = [];
  let next = 1;
  const add = (fn, args, repeat) => {
    const id = next++;
    if (typeof fn === "function") queue.push({ id, fn, args, repeat });
    return id;
  };
  const clear = (id) => {
    const i = queue.findIndex((t) => t.id === id);
    if (i !== -1) queue.splice(i, 1);
  };
  return {
    globals: {
      setTimeout: (fn, _ms, ...args) => add(fn, args, 0),
      setInterval: (fn, _ms, ...args) => add(fn, args, 3),
      setImmediate: (fn, ...args) => add(fn, args, 0),
      clearTimeout: clear,
      clearInterval: clear,
      clearImmediate: clear,
    },
    /** Runs every queued timer (and any it queues), at most `rounds` passes. */
    run(rounds = 20) {
      for (let r = 0; r < rounds && queue.length > 0; r++) {
        for (const t of queue.splice(0)) {
          try {
            t.fn(...t.args);
          } catch {
            // A throwing timer is the preload's problem; what it did before throwing is still checked.
          }
          if (t.repeat > 0) queue.push({ ...t, repeat: t.repeat - 1 });
        }
      }
    },
  };
}

const microtasks = () => new Promise((resolve) => setImmediate(resolve));

/** Runs `code` and returns the list of contract violations (empty when it holds). */
export async function preloadProblems(code) {
  const problems = [];
  const calls = [];
  const listeners = new Map();
  const exposed = [];
  const posts = [];
  let phase = "load";
  const allowedMembers = new Set(["send", "invoke", "on"]);
  const ipcTarget = {
    send: (channel, ...args) => void calls.push({ method: "send", channel, args }),
    invoke: (channel, ...args) => (calls.push({ method: "invoke", channel, args }), Promise.resolve({ ok: false })),
    on: (channel, listener) => void listeners.set(channel, [...(listeners.get(channel) ?? []), listener]),
  };
  const ipcRenderer = new Proxy(ipcTarget, {
    get(target, key) {
      if (!allowedMembers.has(String(key))) problems.push(`ipcRenderer.${String(key)} read`);
      return target[key];
    },
  });
  const contextBridge = {
    exposeInMainWorld: (name, value) => {
      exposed.push([name, value]);
      if (phase !== "load") problems.push(`exposeInMainWorld(${JSON.stringify(String(name))}) after load (${phase})`);
    },
    exposeInIsolatedWorld: () => problems.push("exposeInIsolatedWorld called"),
  };
  const timers = fakeTimers();
  const window = {
    location: { origin: PAGE_ORIGIN, href: `${PAGE_ORIGIN}/index.html` },
    postMessage: (message, targetOrigin, transfer) => void posts.push({ message, targetOrigin, transfer }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  window.window = window;
  window.self = window;
  window.top = window;
  const fakeRequire = (id) => {
    if (id === "electron") return { contextBridge, ipcRenderer };
    problems.push(`require(${JSON.stringify(id)})`);
    return {};
  };
  const module = { exports: {} };
  const sandboxGlobals = {
    ...timers.globals,
    queueMicrotask,
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    process: { platform: "linux", versions: { electron: "45.3.2" }, env: {}, type: "renderer", sandboxed: true, contextIsolated: true, on: () => {}, once: () => {} },
    Buffer: { from: () => new Uint8Array() },
    document: { addEventListener: () => {}, readyState: "complete" },
    location: window.location,
    navigator: { userAgent: "Electron" },
    URL,
    TextEncoder,
    TextDecoder,
  };
  const context = createContext({ require: fakeRequire, module, exports: module.exports, window, ...sandboxGlobals });
  context.globalThis = context;
  context.global = context;
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await microtasks();
      timers.run();
    }
    await microtasks();
  };
  try {
    runInContext(`(function (require, module, exports) {${code}\n})(require, module, exports);`, context, { timeout: 2000 });
  } catch (e) {
    problems.push(`threw while loading: ${e instanceof Error ? e.message : String(e)}`);
    return problems;
  }
  phase = "after load";
  await settle();
  const loadCalls = calls.splice(0);

  // One global, the contract's name, a frozen object of exactly the four functions, none of them leaking ipcRenderer.
  if (exposed.length !== 1 || exposed[0]?.[0] !== PRELOAD_GLOBAL) problems.push(`exposed ${JSON.stringify(exposed.map((e) => String(e[0])))}`);
  const api = exposed[0]?.[1];
  if (typeof api !== "object" || api === null || !Object.isFrozen(api)) problems.push("the global is not a frozen object");
  const keys = api ? Reflect.ownKeys(api).map(String).sort() : [];
  if (JSON.stringify(keys) !== JSON.stringify([...PRELOAD_FUNCTIONS].sort())) problems.push(`keys ${JSON.stringify(keys)}`);
  for (const k of keys) if (typeof api[k] !== "function" || api[k] === ipcRenderer) problems.push(`${k} is not a plain function`);

  // Load: only the three reply channels are listened to, nothing is sent.
  const replyChannels = Object.values(IPC_REPLY_CHANNELS);
  if (JSON.stringify([...listeners.keys()].map(String).sort()) !== JSON.stringify([...replyChannels].sort())) problems.push(`listens on ${JSON.stringify([...listeners.keys()].map(String))}`);
  if (loadCalls.length !== 0) problems.push(`sent at load: ${JSON.stringify(loadCalls.map((c) => String(c.channel)))}`);

  // Each function, called with every hostile value in every position (alone and after valid arguments), sends at most once, on
  // its own fixed channel, with its own method; checked after microtasks and timers ran.
  for (const name of PRELOAD_FUNCTIONS) {
    if (typeof api?.[name] !== "function") continue;
    const want = { method: name === "openExternal" ? "invoke" : "send", channel: IPC_CHANNELS[name] };
    const shapes = [];
    for (const h of HOSTILE) {
      shapes.push([h], [h, h], [h, h, h, h], [VALID.nonce, h], [VALID.nonce, VALID.action, h], [VALID.nonce, h, h], [VALID.url, h]);
    }
    for (const args of shapes) {
      calls.length = 0;
      phase = `calling ${name}`;
      try {
        const out = api[name](...args);
        if (out && typeof out.then === "function") out.then(() => {}, () => {});
      } catch {
        // A throw sends nothing; that is allowed.
      }
      await settle();
      const bad = calls.filter((c) => c.method !== want.method || c.channel !== want.channel);
      if (bad.length > 0 || calls.length > 1) {
        problems.push(`${name} sent ${JSON.stringify(calls.map((c) => [c.method, typeof c.channel === "symbol" ? "symbol" : String(c.channel).slice(0, 40)]))}`);
        break;
      }
    }
  }
  phase = "after calls";
  await settle();

  // Replies go only to the page's own origin, carrying the event's ports, and nothing else of the event.
  for (const [channel, ls] of listeners) {
    for (const l of ls) {
      posts.length = 0;
      const port = { port: true };
      try {
        l({ ports: [port], sender: { secret: true }, senderFrame: { secret: true } }, { answer: 1 });
      } catch (e) {
        problems.push(`${String(channel)} listener threw: ${e instanceof Error ? e.message : String(e)}`);
      }
      await settle();
      for (const p of posts) {
        if (p.targetOrigin !== PAGE_ORIGIN) problems.push(`${String(channel)} posted to ${JSON.stringify(String(p.targetOrigin))}`);
        if (JSON.stringify(p.message).includes("secret")) problems.push(`${String(channel)} leaked the event`);
        if (!Array.isArray(p.transfer) || p.transfer.length !== 1 || p.transfer[0] !== port) problems.push(`${String(channel)} transfer`);
      }
      if (posts.length !== 1) problems.push(`${String(channel)} posted ${posts.length} times`);
    }
  }
  if (exposed.length !== 1) problems.push(`exposeInMainWorld called ${exposed.length} times in all`);
  return problems;
}

/**
 * The textual layer (comments stripped): one `exposeInMainWorld`, `contextBridge` only in the import and that call, and exactly
 * six `ipcRenderer` tokens (the import, the reply `on`, three `send` and one `invoke`), each followed by `.send("axis:`,
 * `.invoke("axis:` or `.on(`. A backdoor needs another token, an alias or a computed member, and fails here.
 */
export function preloadTextProblems(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const problems = [];
  const count = (re) => (code.match(re) ?? []).length;
  if (count(/\bexposeInMainWorld\b/g) !== 1) problems.push("exposeInMainWorld count");
  if (count(/\bcontextBridge\b/g) !== 2) problems.push("contextBridge count");
  if (count(/\bipcRenderer\b/g) !== 6) problems.push(`ipcRenderer count ${count(/\bipcRenderer\b/g)}`);
  const uses = [...code.matchAll(/\bipcRenderer\b(.{0,48})/g)].map((m) => m[1]);
  const shapes = uses.slice(1);
  for (const u of shapes) if (!/^\.(send|invoke)\("axis:[A-Za-z]+"|^\.on\(channel,/.test(u)) problems.push(`ipcRenderer use ${JSON.stringify(u)}`);
  if (!/^import \{ contextBridge, ipcRenderer \} from "electron";$/m.test(code)) problems.push("the import line");
  if (count(/\bimport\b/g) !== 1 || /\brequire\s*\(/.test(code)) problems.push("other imports");
  if (count(/\bpostMessage\b/g) !== 1 || !/window\.postMessage\(\{ channel, data \}, window\.location\.origin, \[\.\.\.event\.ports\]\);/.test(code)) problems.push("the reply post");
  if (/["'`]\*["'`]/.test(code)) problems.push("a wildcard string");
  return problems;
}

export const preloadDir = (appRoot) => join(appRoot, "preload");
