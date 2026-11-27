// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { PALETTES, windowTitle } from "@axis/ui";
import { mainWindowOptions } from "../main/window.js";

test("the window is sandboxed and isolated, with no Node in any frame or worker, and no webview", () => {
  const p = mainWindowOptions("/b", "dark").webPreferences;
  assert.deepEqual(p, {
    preload: join("/b", "preload.cjs"),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
  });
});

test("title from the brand module, background from the theme's canvas token, hidden until ready", () => {
  const dark = mainWindowOptions("/b", "dark");
  const light = mainWindowOptions("/b", "light");
  assert.equal(dark.title, windowTitle());
  assert.equal(dark.backgroundColor, PALETTES.dark.canvas);
  assert.equal(light.backgroundColor, PALETTES.light.canvas);
  assert.notEqual(dark.backgroundColor, light.backgroundColor);
  assert.equal(dark.show, false);
});
