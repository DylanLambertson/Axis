// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The bundle (scripts/bundle.mjs, run by the test script before this): what dist/app holds and what each bundle reaches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundle } from "../scripts/bundle.mjs";

const out = mkdtempSync(join(tmpdir(), "axis-desktop-bundle-"));
const meta = await bundle(out);
test.after(() => rmSync(out, { recursive: true, force: true }));

test("dist/app holds main, preload, the page, its stylesheet and script, and the notices", () => {
  for (const f of ["main.cjs", "preload.cjs", "daemon.cjs", "daemon-entry.cjs", "pty.cjs", "pty-entry.cjs", "renderer/index.html", "renderer/shell.css", "renderer/renderer.js", "THIRD-PARTY-NOTICES.txt"]) {
    assert.ok(existsSync(join(out, f)), f);
  }
});

test("the renderer bundle reaches no Node built-in and no Electron; main and preload keep Electron external", () => {
  const inputs = Object.keys(meta.renderer.inputs);
  assert.ok(inputs.some((i) => i.includes("node_modules/react-dom/")), "react-dom is bundled");
  assert.ok(inputs.some((i) => i.includes("packages/ui/dist/src/tokens.js")), "the tokens are bundled");
  for (const i of inputs) assert.doesNotMatch(i, /^node:|node_modules\/electron\//, i);
  for (const name of ["main", "preload"]) {
    const imports = Object.values(meta[name].outputs).flatMap((o) => o.imports);
    assert.ok(imports.every((i) => i.external === true && (i.path === "electron" || i.path.startsWith("node:") || ["path"].includes(i.path))), name);
  }
  assert.ok(Object.values(meta.main.outputs).flatMap((o) => o.imports).some((i) => i.path === "electron"), "main imports electron");
});

test("the page has a strict CSP: nothing by default, scripts and styles from the bundle only, Trusted Types required", () => {
  const html = readFileSync(join(out, "renderer", "index.html"), "utf8");
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
  assert.ok(csp, "a CSP meta tag");
  const dirs = new Map(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(" ")]));
  assert.equal(dirs.get("default-src"), "'none'");
  assert.equal(dirs.get("script-src"), "'self'");
  assert.equal(dirs.get("style-src"), "'self'");
  assert.equal(dirs.get("connect-src"), "'none'");
  assert.equal(dirs.get("object-src"), "'none'");
  assert.equal(dirs.get("require-trusted-types-for"), "'script'");
  assert.equal(dirs.get("trusted-types"), "'none'");
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/, "no inline script");
  assert.doesNotMatch(html, /\sstyle=|<style/, "no inline style");
});

// OS-3.1: main reaches the daemon host only through its narrow `./main` subpath. Measured at 1,127,211 bytes when this was set
// (zod is about 751 KB of it, needed for the control messages); the budget leaves about 5% headroom and fails when exceeded.
export const MAIN_BUNDLE_BUDGET = 1_185_000;

test("main reaches the daemon host only through its main-side modules, and stays within its size budget", () => {
  const inputs = Object.keys(meta.main.inputs).filter((i) => i.includes("packages/daemon-host/"));
  assert.ok(inputs.length > 0, "main uses the daemon host");
  for (const i of inputs) assert.match(i, /packages\/daemon-host\/dist\/src\/(main\/[^/]+|supervisor|control\/[^/]+)\.js$/, i);
  const all = Object.keys(meta.main.inputs);
  assert.ok(!all.some((i) => /daemon-host\/dist\/src\/(handlers|storage|compose|host|entry)|packages\/(audit|journal|worktrees|runs|review|broker|git-ops|git-snapshot|vault)\//.test(i)), "no composition root, handlers, storage or the daemon's own packages");
  const imports = Object.values(meta.main.outputs).flatMap((o) => o.imports);
  assert.ok(!imports.some((i) => i.path === "node:sqlite"), "no node:sqlite");
  const size = Object.values(meta.main.outputs)[0].bytes;
  assert.ok(size <= MAIN_BUNDLE_BUDGET, `main.cjs is ${size} bytes, over its budget of ${MAIN_BUNDLE_BUDGET}`);
});

test("the forked files reach only their guard, and load their entry bundle by import()", () => {
  for (const name of ["daemon", "pty"]) {
    const inputs = Object.keys(meta[name].inputs).filter((i) => !i.startsWith("<"));
    assert.equal(inputs.filter((i) => i.includes("packages/")).length, 1, `${name}: one package module, the guard`);
    assert.ok(inputs.some((i) => i.endsWith("signal-guard.js")), `${name}: the guard`);
    const imports = Object.values(meta[name].outputs).flatMap((o) => o.imports);
    assert.deepEqual(imports.map((i) => [i.path, i.kind, i.external]), [[`./${name}-entry.cjs`, "dynamic-import", true]], name);
  }
});
