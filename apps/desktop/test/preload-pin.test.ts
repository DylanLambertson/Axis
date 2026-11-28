// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The preload's source pin (ADR 0011 Decision 2: ADR 0003 D7's "no new contextBridge globals" becomes "exactly this one").
// Mutants each test kills: P5 a second global, or the global renamed; P6 a function added, renamed or removed; P7 a channel
// that is not the contract's, or a function sending another function's channel; P8 ipcRenderer, a channel argument or a
// generic send reaching the page; P9 a reply posted to `*`; P10 an import other than electron's contextBridge and ipcRenderer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IPC_CHANNELS, IPC_REPLY_CHANNELS, PRELOAD_FUNCTIONS, PRELOAD_GLOBAL } from "@axis/desktop-main";

// dist/tsc/test -> apps/desktop
const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const src = readFileSync(join(appRoot, "preload", "preload.ts"), "utf8");
const code = src.replace(/^\s*\/\/.*$/gm, "");

test("one global, exactly the contract's name", () => {
  const calls = [...code.matchAll(/contextBridge\.(\w+)\(\s*("[^"]*")/g)];
  assert.deepEqual(calls.map((m) => [m[1], JSON.parse(m[2]!)]), [["exposeInMainWorld", PRELOAD_GLOBAL]], "P5");
  assert.match(code, /contextBridge\.exposeInMainWorld\("axis", api\);/, "P5: the frozen api object");
  assert.equal((code.match(/contextBridge/g) ?? []).length, 2, "P5: the import and the one call");
});

test("exactly the contract's functions, each on its own channel", () => {
  const block = /const api = Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(code)?.[1];
  assert.ok(block, "P6: a frozen object literal");
  const fns = [...block.matchAll(/^  (\w+): \(/gm)].map((m) => m[1]);
  assert.deepEqual(fns, [...PRELOAD_FUNCTIONS], "P6");
  for (const name of PRELOAD_FUNCTIONS) {
    const body: string = new RegExp(`^  ${name}: \\(([^)]*)\\)[^=]*=>([\\s\\S]*?)(?=^  \\w+: \\(|$(?![\\s\\S]))`, "m").exec(block)?.[2] ?? "";
    const sends: Array<[string | undefined, string | undefined]> = [...body.matchAll(/ipcRenderer\.(\w+)\("([^"]+)"/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(sends, [[name === "openExternal" ? "invoke" : "send", IPC_CHANNELS[name]]], `P7: ${name}`);
  }
});

test("no ipcRenderer, channel argument or generic send reaches the page; replies go to the page's own origin", () => {
  const uses = [...code.matchAll(/ipcRenderer\.(\w+)\(\s*([^,)]*)/g)].map((m) => [m[1], m[2]!.trim()]);
  for (const [method, first] of uses) {
    assert.ok(["send", "invoke", "on"].includes(method!), `P8: ipcRenderer.${method}`);
    if (method !== "on") assert.match(first!, /^"axis:[A-Za-z]+"$/, `P8: a literal channel, not ${first}`);
  }
  const literals = [...code.matchAll(/"(axis:[A-Za-z]+)"/g)].map((m) => m[1]);
  const known = new Set([...Object.values(IPC_CHANNELS), ...Object.values(IPC_REPLY_CHANNELS)]);
  for (const l of literals) assert.ok(known.has(l!), `P7: ${l}`);
  const replies = /for \(const channel of (\[[^\]]*\])\)/.exec(code)?.[1];
  assert.deepEqual(JSON.parse(replies ?? "null"), Object.values(IPC_REPLY_CHANNELS), "P7: the reply channels");
  assert.doesNotMatch(code, /exposeInMainWorld\([^)]*ipcRenderer/, "P8");
  assert.doesNotMatch(code, /\bsendSync\b|\bsendToHost\b|\bpostMessage\([^)]*"\*"/, "P8/P9");
  assert.match(code, /window\.postMessage\(\{ channel, data \}, window\.location\.origin, \[\.\.\.event\.ports\]\)/, "P9");
});

test("imports: electron's contextBridge and ipcRenderer only", () => {
  const imports = [...code.matchAll(/^import\s+([\s\S]*?)\s+from\s+"([^"]+)";/gm)].map((m) => [m[1], m[2]]);
  assert.deepEqual(imports, [["{ contextBridge, ipcRenderer }", "electron"]], "P10");
  assert.doesNotMatch(code, /\brequire\(|\bimport\(/, "P10");
});
