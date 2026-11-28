// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The preload pin (ADR 0011 Decision 2: exactly one global). Behavioural: the preload is built as the bundle builds it and run
// against a fake electron (test/preload-behaviour.mjs). Mutants each test kills: P5 a second or renamed global, or one that is
// not frozen; P6 a function added, renamed or removed; P7 a function sending another channel, a renderer-chosen channel (also
// through an alias or a computed member) or more than once; P8 any other ipcRenderer member read, or another module required;
// P9 a reply posted anywhere but the page's own origin (also through a variable), or carrying the IPC event; V3 a backdoor keyed
// on an argument the page chooses; V4 a second global made only where real timers exist; V5 a second global made in a microtask.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPreload, preloadDir, preloadProblems, preloadTextProblems } from "./preload-behaviour.mjs";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(preloadDir(appRoot), "preload.ts"), "utf8");
const run = async (text) => preloadProblems(await buildPreload(text, preloadDir(appRoot)));
const edit = (from, to) => {
  assert.equal(source.split(from).length, 2, `the edit anchor is unique: ${from}`);
  return source.replace(from, to);
};

test("the real preload holds the contract, behaviourally and textually", async () => {
  assert.deepEqual(await run(source), []);
  assert.deepEqual(preloadTextProblems(source), []);
});

test("known-bad edits are caught", async () => {
  const connect = 'connect: (nonce: unknown): void => ipcRenderer.send("axis:connect", nonce),';
  const reply = "window.postMessage({ channel, data }, window.location.origin, [...event.ports]);";
  const bad = {
    "Z1 an aliased generic send": edit(connect, 'connect: (nonce: unknown, ch?: unknown): void => { ipcRenderer.send("axis:connect", nonce); const r = ipcRenderer; if (typeof ch === "string") r.send(ch, nonce); },'),
    "Z2 a computed-member send": edit(connect, 'connect: (nonce: unknown, ch?: unknown): void => { ipcRenderer.send("axis:connect", nonce); if (typeof ch === "string") (ipcRenderer as any)["send"](ch, nonce); },'),
    "Z3 a wildcard reply through a variable": edit(reply, 'const t = "*"; window.postMessage({ channel, data }, t, [...event.ports]);'),
    "P5 a second global": edit('contextBridge.exposeInMainWorld("axis", api);', 'contextBridge.exposeInMainWorld("axis", api); contextBridge.exposeInMainWorld("ipc", ipcRenderer);'),
    "P5 not frozen": edit("const api = Object.freeze({", "const api = ({"),
    "P6 a function added": edit(connect, `${connect}\n  sendAny: (c: string, d: unknown): void => ipcRenderer.send(c, d),`),
    "P7 another channel": edit('ipcRenderer.send("axis:terminalPort"', 'ipcRenderer.send("axis:projectAction"'),
    "P8 another member": edit(connect, 'connect: (nonce: unknown): void => ipcRenderer.sendSync("axis:connect", nonce),'),
    "P9 the event leaked": edit("window.postMessage({ channel, data },", "window.postMessage({ channel, data, event: { ...event } },"),
  };
  for (const [name, text] of Object.entries(bad)) {
    assert.notDeepEqual([...(await run(text)), ...preloadTextProblems(text)], [], name);
  }
});

test("the second review's evasions are caught", async () => {
  const connect = 'connect: (nonce: unknown): void => ipcRenderer.send("axis:connect", nonce),';
  const expose = 'contextBridge.exposeInMainWorld("axis", api);';
  const v3 = edit(connect, 'connect: (nonce: unknown, ch?: unknown): void => { ipcRenderer.send("axis:connect", nonce); if (typeof ch === "number") ipcRenderer.send(`x:${ch}`, nonce); },');
  const v4 = edit(expose, `${expose}\nif (typeof setTimeout === "function") setTimeout(() => contextBridge.exposeInMainWorld("ipc", { send: (c: string, d: unknown) => ipcRenderer.send(c, d) }), 0);`);
  const v5 = edit(expose, `${expose}\nvoid Promise.resolve().then(() => contextBridge.exposeInMainWorld("ipc", { send: (c: string, d: unknown) => ipcRenderer.send(c, d) }));`);
  assert.notDeepEqual(await run(v3), [], "V3 behaviourally: a number argument is among the hostile values");
  assert.notDeepEqual(preloadTextProblems(v3), [], "V3 textually: a seventh ipcRenderer token");
  assert.notDeepEqual(await run(v4), [], "V4: the harness has real-looking timers and runs them");
  assert.notDeepEqual(await run(v5), [], "V5: microtasks are drained before the check");
  const v4b = edit(expose, `${expose}\nif (typeof setInterval === "function") { let n = 0; const t = setInterval(() => { if (++n === 2) { clearInterval(t); contextBridge.exposeInMainWorld("ipc", {}); } }, 10); }`);
  assert.notDeepEqual(await run(v4b), [], "V4: intervals run more than once");
  const late = edit(connect, 'connect: (nonce: unknown): void => { ipcRenderer.send("axis:connect", nonce); setTimeout(() => ipcRenderer.send("evil:late", nonce), 1000); },');
  assert.notDeepEqual(await run(late), [], "a deferred second send from a call");
});
