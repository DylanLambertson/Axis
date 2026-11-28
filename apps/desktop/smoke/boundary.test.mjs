// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Boundary smoke test (OS-2 PR 2): the wired hardening holds in the real Electron. The unpackaged app runs with
// AXIS_DESKTOP_SMOKE=boundary; main runs the page probe (main/boundary-probe.ts) and prints one AXIS_DESKTOP_BOUNDARY line.
// Like window.test.mjs it needs the Electron runtime and a display (CI: xvfb-run), and is not part of `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appDir } from "../scripts/bundle.mjs";

const TIMEOUT_MS = 90_000;
const MARKER = "AXIS_DESKTOP_BOUNDARY ";

function run(electron, userData) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, AXIS_DESKTOP_SMOKE: "boundary" };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [appDir, `--user-data-dir=${userData}`], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`no exit within ${TIMEOUT_MS} ms\n${out}\n${err}`));
    }, TIMEOUT_MS);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

test("the renderer has no network, no inline or eval script, no frames, no new windows, no paste and no way off the app URL", async () => {
  if (process.platform === "linux") assert.ok(process.env.DISPLAY || process.env.WAYLAND_DISPLAY, "no display: run under xvfb-run");
  const electron = createRequire(import.meta.url)("electron");
  assert.equal(typeof electron, "string", "the Electron runtime is not installed: node node_modules/electron/install.js");
  const userData = mkdtempSync(join(tmpdir(), "axis-desktop-boundary-"));
  try {
    const { code, out, err } = await run(electron, userData);
    const line = out.split("\n").find((l) => l.startsWith(MARKER));
    assert.ok(line, `no boundary report (exit ${code})\n${out}\n${err}`);
    const r = JSON.parse(line.slice(MARKER.length));
    // Network: the CSP (connect-src 'none') and the webRequest filter.
    for (const k of ["fetchHttps", "fetchLoopback", "fetchSelf", "websocket", "remoteImage"]) assert.equal(r[k], "refused", k);
    // CSP: no data: image, no inline script, no eval; Trusted Types.
    assert.equal(r.dataImage, "refused");
    assert.equal(r.inlineScript, "refused");
    assert.equal(r.eval, "refused");
    // No frame of the app inside the app, and nothing reachable through one.
    assert.ok(["load", "error"].includes(r.subframeSettled), `the subframe settled (${r.subframeSettled})`);
    assert.equal(r.subframeLoaded, "blocked");
    assert.equal(r.subframeAxis, "none");
    // window.open is denied, also for the app URL.
    assert.equal(r.windowOpen, "denied");
    assert.equal(r.windowOpenHttps, "denied");
    // Permissions: a copy from a user gesture works; paste and everything else are refused.
    assert.equal(r.focused, true, "the window took focus within the bounded retry");
    assert.equal(r.clipboardWrite, "ok", `copy (${r.clipboardFocusRetries})`);
    assert.equal(r.clipboardRead, "refused");
    assert.equal(r.geolocation, "refused");
    // The one frozen global, its four functions, and no Node.
    assert.equal(r.axisFrozen, true);
    assert.equal(r.axisKeys, "connect,openExternal,projectAction,terminalPort");
    assert.equal(r.nodeGlobals, false);
    // EL-5 in main, over IPC from the registered window.
    assert.deepEqual(JSON.parse(r.openExternalScheme), { ok: false, reason: "scheme" });
    assert.deepEqual(JSON.parse(r.openExternalFile), { ok: false, reason: "scheme" });
    assert.deepEqual(JSON.parse(r.openExternalMailto), { ok: false, reason: "mailto_field" });
    // Navigation away (https, another app page, file) is refused: the window stays on the exact app URL.
    assert.equal(r.urlBefore, "axis-app://shell/index.html");
    for (const [target, seen] of Object.entries(r.navigation)) {
      // file: is refused by Chromium in the renderer before main sees it; everything else reaches main's will-frame-navigate.
      const want = target.startsWith("file:") ? "renderer-refused" : "attempted";
      assert.equal(seen, `${want}:axis-app://shell/index.html`, `navigation to ${target} was attempted and refused`);
    }
    assert.equal(r.urlAfterNavigation, "axis-app://shell/index.html");
    // The second window is hardened by the app-wide web-contents-created hook, not by openAppWindow.
    assert.equal(r.secondNavigation, "attempted:axis-app://shell/index.html", "the unregistered window cannot navigate away either");
    // A window main did not register gets nothing over IPC, even on the same session, preload and URL.
    assert.deepEqual(JSON.parse(r.secondWindowOpenExternal), { ok: false, reason: "no_window" });
    assert.equal(code, 0, err);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});
