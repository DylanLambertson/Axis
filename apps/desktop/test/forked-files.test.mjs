// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The two files main forks (OS-3.1, docs/design/own-shell-main-seam.md §3 item 2), pinned as daemon-host's
// test/process-main.test.ts requires: the behavioural SIGUSR1 tests catch neither a static entry import nor a guard registered
// with `once`, so these pins are not redundant. Mutants each test kills: F1 another static import, or code before the guard; F2
// the entry imported statically (its module graph would load before the listener exists); F3 a guard registered with `once`;
// F4 the built file loading any module before the listener exists, or growing past a few kilobytes (V8 parses a whole file
// before its first statement runs, so a large forked file widens the window before the listener).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "../scripts/bundle.mjs";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(appRoot, "..", "..");
const FILES = [
  { name: "daemon", source: join(appRoot, "daemon", "daemon-main.ts"), built: "daemon.cjs", guard: "@axis/daemon-host/signal-guard", entry: "./daemon-entry.cjs", guardSource: join(repoRoot, "packages", "daemon-host", "src", "signal-guard.ts") },
  { name: "pty", source: join(appRoot, "pty", "pty-main.ts"), built: "pty.cjs", guard: "@axis/pty-process/signal-guard", entry: "./pty-entry.cjs", guardSource: join(repoRoot, "packages", "pty-process", "src", "signal-guard.ts") },
];
const code = (path) => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").trim();

for (const f of FILES) {
  test(`${f.name}: the source's one static import is the guard, first; the entry comes by import()`, () => {
    const src = code(f.source);
    const statics = [...src.matchAll(/^\s*import\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["'];?/gm)].map((m) => m[1]);
    assert.deepEqual(statics, [f.guard], "F1: exactly one static import, the guard");
    assert.ok(src.startsWith(`import "${f.guard}";`), "F1: nothing before the guard");
    const dynamic = [...src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    assert.deepEqual(dynamic, [f.entry], "F2: the entry by import()");
    assert.doesNotMatch(src, /\brequire\s*\(/, "F2: no require");
  });

  test(`${f.name}: the guard registers its listener with on, never once`, () => {
    const g = code(f.guardSource);
    assert.match(g, /process\.on\(\s*"SIGUSR1"/, "F3");
    assert.doesNotMatch(g, /\bonce\s*\(/, "F3");
  });
}

const out = mkdtempSync(join(tmpdir(), "axis-desktop-forked-"));
await bundle(out);
test.after(() => rmSync(out, { recursive: true, force: true }));

const hook = join(out, "trace-hook.cjs");
writeFileSync(
  hook,
  `const Module = require("node:module");
const seq = [];
const load = Module._load;
Module._load = function (request) { seq.push("load " + request); return load.apply(this, arguments); };
const on = process.on.bind(process);
const once = process.once.bind(process);
process.on = function (event, fn) { if (event === "SIGUSR1") seq.push("on SIGUSR1"); return on(event, fn); };
process.once = function (event, fn) { if (event === "SIGUSR1") seq.push("once SIGUSR1"); return once(event, fn); };
process.on("exit", () => require("node:fs").writeSync(2, "TRACE " + JSON.stringify(seq) + "\\n"));
`,
);

for (const f of FILES) {
  test(`${f.name}: the built file installs the listener before it loads any module`, () => {
    const r = spawnSync(process.execPath, ["--require", hook, join(out, f.built)], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8", timeout: 30_000 });
    const line = r.stderr.split("\n").find((l) => l.startsWith("TRACE "));
    assert.ok(line, `no trace\n${r.stderr}`);
    // The first load is the built file itself, before any of its code runs.
    const seq = JSON.parse(line.slice(6)).filter((s) => s !== `load ${join(out, f.built)}`);
    assert.equal(seq[0], "on SIGUSR1", `F4: the listener first: ${JSON.stringify(seq.slice(0, 5))}`);
    assert.ok(!seq.includes("once SIGUSR1"), "F3");
    assert.equal(seq[1], `load ${join(out, `${f.name}-entry.cjs`)}`, "the entry bundle loads right after the listener");
  });

  test(`${f.name}: the built forked file is tiny, so nearly nothing is parsed before the listener`, () => {
    const size = readFileSync(join(out, f.built)).length;
    assert.ok(size < 4096, `F4: ${f.built} is ${size} bytes`);
  });
}
