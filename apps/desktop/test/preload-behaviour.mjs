// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Runs a BUILT preload (CommonJS, as scripts/bundle.mjs builds it) in node:vm with a fake `electron`, a fake `window` and the
// globals a sandboxed preload really has (timers included, driven by the harness), calls every exposed function with a wide set
// of hostile arguments, drains microtasks and timers after every step, and lists every way it departs from the contract.
// It is the second layer behind the exact pin in preload-pin.test.mjs, which uses it on the real preload and on known-bad edits.
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

/** One hour of virtual time: the horizon timers and `Date` are driven to. */
export const VIRTUAL_HORIZON_MS = 60 * 60 * 1000;
const START = Date.UTC(2026, 0, 1);

/**
 * A virtual clock: timers fire in due order as the harness advances time, and the vm's `Date` and `performance.now` read the
 * same clock, so a preload cannot tell virtual time from wall time. Intervals keep firing until the horizon (bounded in count).
 */
function virtualClock() {
  let now = 0;
  let next = 1;
  let fired = 0;
  const timers = new Map();
  const add = (fn, ms, args, interval) => {
    const id = next++;
    const delay = Math.max(0, Number(ms) || 0);
    if (typeof fn === "function") timers.set(id, { fn, args, due: now + delay, every: interval ? Math.max(1, delay) : 0 });
    return id;
  };
  const clear = (id) => void timers.delete(id);
  const RealDate = Date;
  class VirtualDate extends RealDate {
    constructor(...a) {
      if (a.length === 0) super(START + now);
      else super(...a);
    }
    static now() {
      return START + now;
    }
  }
  return {
    globals: {
      setTimeout: (fn, ms, ...args) => add(fn, ms, args, false),
      setInterval: (fn, ms, ...args) => add(fn, ms, args, true),
      setImmediate: (fn, ...args) => add(fn, 0, args, false),
      clearTimeout: clear,
      clearInterval: clear,
      clearImmediate: clear,
      Date: VirtualDate,
      performance: { now: () => now, timeOrigin: START },
    },
    /** Fires every timer due up to `until` (virtual ms since start), in due order; returns false when the count bound is hit. */
    advance(until) {
      for (;;) {
        let id;
        let t;
        for (const [k, v] of timers) if (v.due <= until && (t === undefined || v.due < t.due)) [id, t] = [k, v];
        if (t === undefined) return true;
        now = Math.max(now, t.due);
        if (t.every > 0) t.due = now + t.every;
        else timers.delete(id);
        if (++fired > 100_000) return false;
        try {
          t.fn(...t.args);
        } catch {
          // A throwing timer is the preload's problem; what it did before throwing is still checked.
        }
      }
    },
    get now() {
      return now;
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
  const clock = virtualClock();
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
    ...clock.globals,
    queueMicrotask,
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    process: { platform: "linux", versions: { electron: "45.3.2", chrome: "140.0.7339.249", node: "22.20.0", v8: "14.0.365.10-electron.0" }, env: {}, type: "renderer", sandboxed: true, contextIsolated: true, on: () => {}, once: () => {} },
    Buffer: { from: () => new Uint8Array() },
    document: { addEventListener: () => {}, readyState: "complete" },
    location: window.location,
    navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) axis-shell/0.0.0 Chrome/140.0.7339.249 Electron/45.3.2 Safari/537.36", platform: "Linux x86_64", language: "en-US" },
    URL,
    TextEncoder,
    TextDecoder,
  };
  const context = createContext({ require: fakeRequire, module, exports: module.exports, window, ...sandboxGlobals });
  context.globalThis = context;
  context.global = context;
  /** Drains microtasks, then runs the virtual clock to the horizon (microtasks drained between steps). */
  const settle = async () => {
    await microtasks();
    for (let step = 1; step <= 60; step++) {
      if (!clock.advance(clock.now + VIRTUAL_HORIZON_MS / 60)) {
        problems.push("timers fire without end");
        break;
      }
      await microtasks();
    }
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

  // Replies go only to the page's own origin, carrying only the event's ports. The event records every other member read (its
  // `sender` is the renderer's ipcRenderer in Electron), so storing or reading it is a violation. Fired before and after the calls.
  const fireReplies = async (when) => {
    calls.length = 0;
    for (const [channel, ls] of listeners) {
      for (const l of ls) {
        posts.length = 0;
        const port = { port: true };
        const target = { ports: [port], sender: ipcRenderer, senderFrame: {}, processId: 1, frameId: 1 };
        const event = new Proxy(target, {
          get(t, key) {
            if (key !== "ports") problems.push(`${String(channel)} read event.${String(key)} (${when})`);
            return t[key];
          },
          ownKeys(t) {
            problems.push(`${String(channel)} enumerated the event (${when})`);
            return Reflect.ownKeys(t);
          },
          has(t, key) {
            if (key !== "ports") problems.push(`${String(channel)} probed event.${String(key)} (${when})`);
            return key in t;
          },
          getOwnPropertyDescriptor(t, key) {
            if (key !== "ports") problems.push(`${String(channel)} described event.${String(key)} (${when})`);
            return Reflect.getOwnPropertyDescriptor(t, key);
          },
        });
        try {
          l(event, { answer: 1 });
        } catch (e) {
          problems.push(`${String(channel)} listener threw: ${e instanceof Error ? e.message : String(e)}`);
        }
        await settle();
        for (const p of posts) {
          if (p.targetOrigin !== PAGE_ORIGIN) problems.push(`${String(channel)} posted to ${JSON.stringify(String(p.targetOrigin))}`);
          if (!Array.isArray(p.transfer) || p.transfer.length !== 1 || p.transfer[0] !== port) problems.push(`${String(channel)} transfer`);
        }
        if (posts.length !== 1) problems.push(`${String(channel)} posted ${posts.length} times (${when})`);
      }
    }
    if (calls.length !== 0) problems.push(`a reply sent ${JSON.stringify(calls.map((c) => String(c.channel)))} (${when})`);
    calls.length = 0;
  };
  phase = "replies before calls";
  await fireReplies("before the calls");

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
  phase = "replies after calls";
  await fireReplies("after the calls");

  if (exposed.length !== 1) problems.push(`exposeInMainWorld called ${exposed.length} times in all`);
  return problems;
}

/** The preload's text with comments stripped and all whitespace collapsed to single spaces: what the exact pin compares. */
export function normalisePreload(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const preloadDir = (appRoot) => join(appRoot, "preload");
