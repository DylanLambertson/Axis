// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Mounted frame checks (OS-6 review SF1, SF2, SF4): runs frame-probe.cjs in Electron against the bundled renderer and
// checks what it saw. Like window.test.mjs it needs the Electron runtime and a display, so it runs with
// `npm run smoke --workspace @axis/desktop` (CI: xvfb-run), not in `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appDir } from "../scripts/bundle.mjs";

const MARKER = "AXIS_FRAME_PROBE ";
const TIMEOUT_MS = 120_000;
const probe = join(dirname(fileURLToPath(import.meta.url)), "frame-probe.cjs");

let seen;
async function result() {
  if (seen) return seen;
  if (process.platform === "linux") assert.ok(process.env.DISPLAY || process.env.WAYLAND_DISPLAY, "no display: run under xvfb-run");
  const electron = createRequire(import.meta.url)("electron");
  assert.equal(typeof electron, "string", "the Electron runtime is not installed: node node_modules/electron/install.js");
  const userData = mkdtempSync(join(tmpdir(), "axis-frame-probe-"));
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const out = await new Promise((resolve, reject) => {
      const child = spawn(electron, [`--user-data-dir=${userData}`, probe, join(appDir, "dist", "app")], { env, stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      let err = "";
      child.stdout.on("data", (d) => (text += d));
      child.stderr.on("data", (d) => (err += d));
      const timer = setTimeout(() => (child.kill("SIGKILL"), reject(new Error(`no exit within ${TIMEOUT_MS} ms\n${err}`))), TIMEOUT_MS);
      child.on("error", reject);
      child.on("close", () => (clearTimeout(timer), resolve({ text, err })));
    });
    const line = out.text.split("\n").find((l) => l.startsWith(MARKER));
    assert.ok(line, `no probe report\n${out.text}\n${out.err}`);
    seen = JSON.parse(line.slice(MARKER.length));
    assert.equal(seen.error, undefined, seen.error);
    return seen;
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
}

test("SF1: the palette ignores composing, repeated and modified Enter, and an input-method Escape; a plain Enter runs", async () => {
  const p = (await result()).palette;
  assert.deepEqual([p.opened.dialog, p.opened.focus], [true, "combobox"]);
  for (const step of ["composingEnter", "processKey", "composingEscape", "repeatedEnter", "ctrlEnter"]) {
    assert.deepEqual({ dialog: p[step].dialog, focus: p[step].focus, hash: p[step].hash }, { dialog: true, focus: "combobox", hash: "#/home" }, `${step}: still open, nothing ran`);
  }
  assert.deepEqual([p.emptyEnter.dialog, p.emptyEnter.empty, p.emptyEnter.focus], [true, true, "combobox"], "Enter with no match does nothing");
  assert.deepEqual([p.plainEnter.dialog, p.plainEnter.focus], [false, "main"], "a plain Enter closes and runs the first command (Focus next region, from the rail)");
});

test("SF4: the rail keeps exactly one tab stop through roving and route changes by hash and palette", async () => {
  const r = (await result()).rail;
  const one = (stops, at, what) => assert.deepEqual(stops, [0, 1, 2, 3].map((i) => (i === at ? 0 : -1)), what);
  one(r.roved.stops, 1, "ArrowDown moves the stop without navigating");
  assert.equal(r.roved.hash, "#/home");
  one(r.afterHash.stops, 3, "a hash change puts the one stop on the current page");
  assert.equal(r.arrowAfterHash.focus, "button:Agents", "the arrow moves on from the current page");
  one(r.arrowAfterHash.stops, 2, "");
  one(r.afterPalette.stops, 0, "Go to Home from the palette");
  assert.equal(r.afterPalette.focus, "main");
  one(r.backToRoved.stops, 0, "a stop roved before leaving a page is not brought back on return");
});

test("SF2: at 320 CSS px (400% zoom) nothing scrolls sideways, in both themes, with long names and the read-only tag", async () => {
  const all = await result();
  for (const theme of ["reflowDark", "reflowLight"]) {
    for (const [where, m] of Object.entries(all[theme])) {
      assert.equal(m.width, 320, `${theme} ${where}: the zoomed width`);
      assert.ok(m.page <= m.width, `${theme} ${where}: page ${m.page} wider than ${m.width}`);
      assert.equal(m.main, 0, `${theme} ${where}: the main region scrolls sideways`);
      for (const k of ["commands", "activity"]) assert.ok(m[k] > 0 && m[k] <= m.width, `${theme} ${where}: ${k} ends at ${m[k]}`);
    }
    assert.ok(all[theme].longNameReadOnly.tag > 0 && all[theme].longNameReadOnly.tag <= 320, `${theme}: the read-only tag is on screen`);
  }
});
