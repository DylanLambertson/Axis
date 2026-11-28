// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Runs a BUILT preload (CommonJS, as scripts/bundle.mjs builds it) in node:vm with a fake `electron` and a fake `window`, calls
// every exposed function with hostile arguments, and lists every way it departs from the contract. Used by
// preload-pin.test.mjs on the real preload and on known-bad edits.
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

const HOSTILE = [
  "evil:channel",
  "axis:projectAction",
  { toString: () => "evil:channel" },
  Object.defineProperty({}, "x", { get: () => "evil:channel", enumerable: true }),
  ["evil:channel"],
];

/** Runs `code` and returns the list of contract violations (empty when it holds). */
export function preloadProblems(code) {
  const problems = [];
  const calls = [];
  const listeners = new Map();
  const exposed = [];
  const posts = [];
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
  const contextBridge = { exposeInMainWorld: (name, value) => void exposed.push([name, value]) };
  const window = {
    location: { origin: PAGE_ORIGIN },
    postMessage: (message, targetOrigin, transfer) => void posts.push({ message, targetOrigin, transfer }),
  };
  const fakeRequire = (id) => {
    if (id === "electron") return { contextBridge, ipcRenderer };
    problems.push(`require(${JSON.stringify(id)})`);
    return {};
  };
  const module = { exports: {} };
  const context = createContext({ require: fakeRequire, module, exports: module.exports, window, Object, Array, Promise, JSON, Symbol, Reflect });
  try {
    runInContext(`(function (require, module, exports) {${code}\n})(require, module, exports);`, context, { timeout: 2000 });
  } catch (e) {
    problems.push(`threw while loading: ${e instanceof Error ? e.message : String(e)}`);
    return problems;
  }

  // One global, the contract's name, a frozen object of exactly the four functions, none of them leaking ipcRenderer.
  if (exposed.length !== 1 || exposed[0]?.[0] !== PRELOAD_GLOBAL) problems.push(`exposed ${JSON.stringify(exposed.map((e) => e[0]))}`);
  const api = exposed[0]?.[1];
  if (typeof api !== "object" || api === null || !Object.isFrozen(api)) problems.push("the global is not a frozen object");
  const keys = api ? Reflect.ownKeys(api).map(String).sort() : [];
  if (JSON.stringify(keys) !== JSON.stringify([...PRELOAD_FUNCTIONS].sort())) problems.push(`keys ${JSON.stringify(keys)}`);
  for (const k of keys) if (typeof api[k] !== "function" || api[k] === ipcRenderer) problems.push(`${k} is not a plain function`);

  // Load time: only the three reply channels are listened to, nothing is sent.
  const replyChannels = Object.values(IPC_REPLY_CHANNELS);
  if (JSON.stringify([...listeners.keys()].sort()) !== JSON.stringify([...replyChannels].sort())) problems.push(`listens on ${JSON.stringify([...listeners.keys()])}`);
  if (calls.length !== 0) problems.push(`sent at load: ${JSON.stringify(calls.map((c) => c.channel))}`);

  // Each function, called with hostile arguments, sends exactly once, on its own fixed channel, with its own method.
  for (const name of PRELOAD_FUNCTIONS) {
    if (typeof api?.[name] !== "function") continue;
    for (const h of HOSTILE) {
      calls.length = 0;
      try {
        api[name](h, h, h, h);
      } catch {
        // A throw sends nothing; that is allowed.
      }
      const want = { method: name === "openExternal" ? "invoke" : "send", channel: IPC_CHANNELS[name] };
      const bad = calls.filter((c) => c.method !== want.method || c.channel !== want.channel);
      if (bad.length > 0 || calls.length > 1) problems.push(`${name} sent ${JSON.stringify(calls.map((c) => [c.method, String(c.channel)]))}`);
    }
  }

  // Replies go only to the page's own origin, carrying the event's ports, and nothing else of the event.
  for (const [channel, ls] of listeners) {
    for (const l of ls) {
      posts.length = 0;
      const port = { port: true };
      l({ ports: [port], sender: { secret: true }, senderFrame: { secret: true } }, { answer: 1 });
      for (const p of posts) {
        if (p.targetOrigin !== PAGE_ORIGIN) problems.push(`${channel} posted to ${JSON.stringify(p.targetOrigin)}`);
        if (JSON.stringify(p.message).includes("secret")) problems.push(`${channel} leaked the event`);
        if (!Array.isArray(p.transfer) || p.transfer.length !== 1 || p.transfer[0] !== port) problems.push(`${channel} transfer`);
      }
      if (posts.length !== 1) problems.push(`${channel} posted ${posts.length} times`);
    }
  }
  return problems;
}

export const preloadDir = (appRoot) => join(appRoot, "preload");
