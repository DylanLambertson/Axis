// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The one fixed preload of the own shell (ADR 0011 Decision 2, "One preload, fixed and small"). It exposes exactly one frozen
// global, `axis`, with four functions, and each sends one fixed channel: no `ipcRenderer`, no channel argument, no generic send.
// Main checks every sender and parses every payload (@axis/desktop-main); this file only shapes the call. Main's answers on the
// three reply channels are posted to the page's own origin, never `*`, with the ports main sent. test/preload-pin.test.ts pins
// this source against the contract; change both together.
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
