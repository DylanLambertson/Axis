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

test("SF1, review 2 F1: the palette ignores composing (flag, keyCode 229, an open composition), repeated and modified Enter, and an input-method Escape; a plain Enter runs once the composition ends", async () => {
  const p = (await result()).palette;
  assert.deepEqual([p.opened.dialog, p.opened.focus], [true, "combobox"]);
  for (const step of ["composingEnter", "processKey", "composingEscape", "repeatedEnter", "ctrlEnter", "imeCodeEnter", "openCompositionEnter", "openCompositionEscape"]) {
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

test("SF2, review 2 F2: nothing but a diff scrolls sideways at 320 CSS px (400% zoom), with long names, the read-only tag, WCAG spacing and 200% text, in both themes", async () => {
  const all = await result();
  for (const theme of ["reflowDark", "reflowLight"]) {
    const r = all[theme];
    for (const [where, m] of Object.entries(r)) {
      const what = `${theme} ${where}`;
      assert.equal(m.width, where.startsWith("wide") ? 1280 : 320, `${what}: the zoomed width`);
      assert.ok(m.page <= m.width, `${what}: page ${m.page} wider than ${m.width}`);
      assert.equal(m.main, 0, `${what}: the main region scrolls sideways`);
      assert.equal(m.rail, 0, `${what}: the rail scrolls sideways`);
      assert.ok(m.far <= m.width + 0.5, `${what}: ${m.farWhat} ends at ${m.far}, past ${m.width}`);
      for (const k of ["commands", "activity"]) assert.ok(m[k] > 0 && m[k] <= m.width, `${what}: ${k} ends at ${m[k]}`);
    }
    assert.ok(r.longNameReadOnly.tag > 0 && r.longNameReadOnly.tag <= 320, `${theme}: the read-only tag is on screen`);
    for (const where of ["gallerySpaced", "homeSpaced", "wideSpacedLarge"]) assert.equal(r[where].letterSpacing, `${(11 * (where.includes("Large") ? 2 : 1) * 0.12).toFixed(2).replace(/\.?0+$/, "")}px`, `${theme} ${where}: the spacing applied`);
    for (const where of ["galleryLarge", "homeLarge", "wideLarge"]) assert.equal(r[where].fontSize, 22, `${theme} ${where}: the rail's 11px text doubled`);
    assert.equal(r.gallery.fontSize, 11);
    assert.equal(r.gallery.railWidth, 72, `${theme}: the rail keeps its 72px at normal text`);
    assert.ok(r.wideLarge.railWidth > 72 && r.wideLarge.railWidth <= 160, `${theme}: with room, the rail widens for enlarged labels (${r.wideLarge.railWidth}px) rather than breaking them`);
  }
});
