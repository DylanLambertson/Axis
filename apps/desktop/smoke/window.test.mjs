// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Smoke test (OS-1): the bundled app opens its empty window, the renderer mounts, and the app exits on its own. Needs the
// Electron runtime (`node node_modules/electron/install.js`) and a display (CI: xvfb-run). Run with
// `npm run smoke --workspace @axis/desktop`, which bundles first. It is not part of `npm test`: the gate has no display.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowTitle } from "@axis/ui";
import { appDir } from "../scripts/bundle.mjs";

const TIMEOUT_MS = 60_000;
const MARKER = "AXIS_DESKTOP_SMOKE ";

function run(electron, userData) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, AXIS_DESKTOP_SMOKE: "1", ELECTRON_ENABLE_LOGGING: "1" };
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
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, err });
    });
  });
}

test("the app opens its window, the renderer mounts with no Node in the page, and the app exits 0", async () => {
  if (process.platform === "linux") assert.ok(process.env.DISPLAY || process.env.WAYLAND_DISPLAY, "no display: run under xvfb-run");
  const electron = createRequire(import.meta.url)("electron");
  assert.equal(typeof electron, "string", "the Electron runtime is not installed: node node_modules/electron/install.js");
  const userData = mkdtempSync(join(tmpdir(), "axis-desktop-smoke-"));
  try {
    const { code, signal, out, err } = await run(electron, userData);
    const line = out.split("\n").find((l) => l.startsWith(MARKER));
    assert.ok(line, `no smoke report (exit ${code}, signal ${signal})\n${out}\n${err}`);
    assert.deepEqual(JSON.parse(line.slice(MARKER.length)), { mounted: true, title: windowTitle(), nodeInPage: false });
    assert.equal(code, 0, err);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test("the bundle ships the generated notices and Chromium's licence file from the Electron runtime", () => {
  for (const f of ["THIRD-PARTY-NOTICES.txt", "LICENSES.chromium.html"]) {
    const p = join(appDir, "dist", "app", f);
    assert.ok(existsSync(p) && statSync(p).size > 1000, f);
  }
});
