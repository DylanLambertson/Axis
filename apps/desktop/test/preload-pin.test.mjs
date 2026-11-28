// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The preload pin (ADR 0011 Decision 2: exactly one global). Two layers. The decisive one is an EXACT pin: the preload's code
// (comments stripped, whitespace collapsed) must equal REVIEWED below, and the built preload must equal the reviewed copy's
// build, so any change to the preload changes this file in the same diff, where review sees it. The second layer is behavioural:
// the preload is built as the bundle builds it and run against a fake electron (test/preload-behaviour.mjs). Mutants each test kills: P5 a second or renamed global, or one that is
// not frozen; P6 a function added, renamed or removed; P7 a function sending another channel, a renderer-chosen channel (also
// through an alias or a computed member) or more than once; P8 any other ipcRenderer member read, or another module required;
// P9 a reply posted anywhere but the page's own origin (also through a variable), or carrying the IPC event; V3 a backdoor keyed
// on an argument the page chooses; V4 a second global made only where real timers exist; V5 a second global made in a microtask.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPreload, normalisePreload, preloadDir, preloadProblems } from "./preload-behaviour.mjs";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(preloadDir(appRoot), "preload.ts"), "utf8");
const REVIEWED = String.raw`
import { contextBridge, ipcRenderer } from "electron";

for (const channel of ["axis:connectResult", "axis:projectActionResult", "axis:terminalPortResult"]) {
  ipcRenderer.on(channel, (event, data: unknown) => {
    window.postMessage({ channel, data }, window.location.origin, [...event.ports]);
  });
}

const api = Object.freeze({
  connect: (nonce: unknown): void => ipcRenderer.send("axis:connect", nonce),
  projectAction: (nonce: unknown, action: unknown, projectId?: unknown): void =>
    ipcRenderer.send("axis:projectAction", projectId === undefined ? { nonce, action } : { nonce, action, projectId }),
  terminalPort: (nonce: unknown, terminalId: unknown): void => ipcRenderer.send("axis:terminalPort", { nonce, terminalId }),
  openExternal: (url: unknown): Promise<unknown> => ipcRenderer.invoke("axis:openExternal", { url }),
});

contextBridge.exposeInMainWorld("axis", api);
`;

const run = async (text) => preloadProblems(await buildPreload(text, preloadDir(appRoot)));
const edit = (from, to) => {
  assert.equal(source.split(from).length, 2, `the edit anchor is unique: ${from}`);
  return source.replace(from, to);
};

const pinned = (text) => normalisePreload(text) === normalisePreload(REVIEWED);

test("the preload is exactly the reviewed copy, as source and as built", async () => {
  assert.equal(normalisePreload(source), normalisePreload(REVIEWED), "preload/preload.ts changed: review it, then update REVIEWED in this file");
  assert.equal(await buildPreload(source, preloadDir(appRoot)), await buildPreload(REVIEWED, preloadDir(appRoot)));
  assert.ok(pinned(source.replace("const api", "// a comment\n\nconst   api")), "comments and whitespace do not matter");
});

test("the real preload holds the contract behaviourally", async () => {
  assert.deepEqual(await run(source), []);
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
    assert.equal(pinned(text), false, `${name}: the exact pin`);
    assert.notDeepEqual(await run(text), [], `${name}: behaviourally`);
  }
});

test("the second review's evasions are caught", async () => {
  const connect = 'connect: (nonce: unknown): void => ipcRenderer.send("axis:connect", nonce),';
  const expose = 'contextBridge.exposeInMainWorld("axis", api);';
  const v3 = edit(connect, 'connect: (nonce: unknown, ch?: unknown): void => { ipcRenderer.send("axis:connect", nonce); if (typeof ch === "number") ipcRenderer.send(`x:${ch}`, nonce); },');
  const v4 = edit(expose, `${expose}\nif (typeof setTimeout === "function") setTimeout(() => contextBridge.exposeInMainWorld("ipc", { send: (c: string, d: unknown) => ipcRenderer.send(c, d) }), 0);`);
  const v5 = edit(expose, `${expose}\nvoid Promise.resolve().then(() => contextBridge.exposeInMainWorld("ipc", { send: (c: string, d: unknown) => ipcRenderer.send(c, d) }));`);
  assert.notDeepEqual(await run(v3), [], "V3 behaviourally: a number argument is among the hostile values");
  for (const [n, t] of Object.entries({ v3, v4, v5 })) assert.equal(pinned(t), false, `${n}: the exact pin`);
  assert.notDeepEqual(await run(v4), [], "V4: the harness has real-looking timers and runs them");
  assert.notDeepEqual(await run(v5), [], "V5: microtasks are drained before the check");
  const v4b = edit(expose, `${expose}\nif (typeof setInterval === "function") { let n = 0; const t = setInterval(() => { if (++n === 2) { clearInterval(t); contextBridge.exposeInMainWorld("ipc", {}); } }, 10); }`);
  assert.notDeepEqual(await run(v4b), [], "V4: intervals run more than once");
  const late = edit(connect, 'connect: (nonce: unknown): void => { ipcRenderer.send("axis:connect", nonce); setTimeout(() => ipcRenderer.send("evil:late", nonce), 1000); },');
  assert.notDeepEqual(await run(late), [], "a deferred second send from a call");
});

test("the third review's evasions fail the exact pin, and the behavioural layer", async () => {
  const replyListener = "ipcRenderer.on(channel, (event, data: unknown) => {";
  const connect = 'connect: (nonce: unknown): void => ipcRenderer.send("axis:connect", nonce),';
  const expose = 'contextBridge.exposeInMainWorld("axis", api);';
  const n1 = edit(replyListener, "ipcRenderer.on(channel, (event, data: unknown) => { (globalThis as any).__s = event.sender;").replace(
    connect,
    'connect: (nonce: unknown, ch?: unknown): void => { ipcRenderer.send("axis:connect", nonce); const s = (globalThis as any).__s; if (s && typeof ch === "string") s.send(ch, nonce); },',
  );
  const n2 = edit(expose, 'for (const [n, v] of navigator.userAgent.includes("Chrome/") ? [["axis", api], ["ipc", { s: (c: string) => ipcRenderer.send(c) }]] : [["axis", api]]) contextBridge.exposeInMainWorld(n as string, v);');
  const n3 = edit(expose, `${expose}\nconst t0 = Date.now(); const tick = (): void => { if (Date.now() - t0 > 30_000) contextBridge.exposeInMainWorld("ipc", {}); else setTimeout(tick, 1000); }; setTimeout(tick, 1000);`);
  const n4 = edit(expose, 'for (const [n, v] of (process as any).versions.chrome ? [["axis", api], ["ipc", {}]] : [["axis", api]]) contextBridge.exposeInMainWorld(n as string, v);');
  for (const [name, text] of Object.entries({ n1, n2, n3, n4 })) {
    assert.equal(pinned(text), false, `${name}: the exact pin`);
    assert.notDeepEqual(await run(text), [], `${name}: behaviourally`);
  }
});
