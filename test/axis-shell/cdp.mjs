// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Minimal Chrome DevTools Protocol client for driving an Axis window that was
// started with --remote-debugging-port. Node 24's global WebSocket and fetch
// only; no dependencies.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

/** DOM `code` and virtual key code for the keys the smoke test presses. */
const KEYS = {
  Enter: ["Enter", 13, "\r"],
  Escape: ["Escape", 27],
  Tab: ["Tab", 9],
  Space: ["Space", 32, " "],
  ArrowDown: ["ArrowDown", 40],
  ArrowUp: ["ArrowUp", 38],
  ArrowLeft: ["ArrowLeft", 37],
  ArrowRight: ["ArrowRight", 39],
  Home: ["Home", 36],
  End: ["End", 35],
  F6: ["F6", 117],
  "[": ["BracketLeft", 219, "["],
  "]": ["BracketRight", 221, "]"],
};

function keySpec(key) {
  if (KEYS[key]) {
    const [code, vk, text] = KEYS[key];
    return { key, code, vk, text };
  }
  if (/^[0-9]$/.test(key)) {
    return { key, code: `Digit${key}`, vk: 48 + Number(key), text: key };
  }
  if (/^[a-z]$/i.test(key)) {
    return { key: key.toLowerCase(), code: `Key${key.toUpperCase()}`, vk: key.toUpperCase().charCodeAt(0), text: key.toLowerCase() };
  }
  throw new Error(`unknown key ${key}`);
}

export async function connect(port, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let target;
  while (!target) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === "page" && /workbench(-dev)?\.html/.test(t.url));
    } catch {
      // not listening yet
    }
    if (!target) {
      if (Date.now() > deadline) {
        throw new Error(`no workbench page on port ${port}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return new CdpSession(target.webSocketDebuggerUrl).open();
}

export class CdpSession {
  #ws;
  #nextId = 1;
  #pending = new Map();

  constructor(url) {
    this.url = url;
  }

  open() {
    return new Promise((resolve, reject) => {
      this.#ws = new WebSocket(this.url);
      this.#ws.onopen = () => resolve(this);
      this.#ws.onerror = (e) => reject(new Error(`CDP socket error: ${e.message ?? e.type}`));
      this.#ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        const pending = message.id && this.#pending.get(message.id);
        if (pending) {
          this.#pending.delete(message.id);
          message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
        }
      };
    });
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  /** Evaluates an expression in the page and returns its JSON value. */
  async eval(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(`page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result.value;
  }

  /** Polls an expression until it is truthy. */
  async waitFor(expression, { timeoutMs = 20_000, what = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await this.eval(expression).catch(() => undefined);
      if (value) {
        return value;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for: ${what}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** Presses a key with modifiers, e.g. press("v", ["Control", "Shift", "Alt"]). */
  async press(key, modifiers = []) {
    const spec = keySpec(key);
    const mask = modifiers.reduce((m, name) => m | MODIFIERS[name], 0);
    const base = { modifiers: mask, key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk };
    const plainText = spec.text && (mask & ~MODIFIERS.Shift) === 0;
    await this.send("Input.dispatchKeyEvent", { type: plainText ? "keyDown" : "rawKeyDown", ...base, ...(plainText ? { text: spec.text } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await new Promise((r) => setTimeout(r, 150));
  }

  async type(text) {
    await this.send("Input.insertText", { text });
  }

  async screenshot(dir, name) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    const file = join(dir, `${name}.png`);
    await writeFile(file, Buffer.from(data, "base64"));
    return file;
  }

  close() {
    this.#ws.close();
  }
}
