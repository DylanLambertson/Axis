// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { PALETTES, windowTitle } from "@axis/ui";
import { APP_PARTITION, appWebPreferences } from "@axis/desktop-main";
import { mainWindowOptions } from "../main/window.js";

test("the window takes the hardened web preferences: sandboxed, isolated, the app partition, DevTools only unpackaged", () => {
  const p = mainWindowOptions("/b", "dark", true).webPreferences;
  assert.deepEqual(p, { ...appWebPreferences({ preload: join("/b", "preload.cjs"), packaged: true }) });
  assert.equal(p?.sandbox, true);
  assert.equal(p?.contextIsolation, true);
  assert.equal(p?.nodeIntegration, false);
  assert.equal(p?.partition, APP_PARTITION);
  assert.equal(p?.devTools, false);
  assert.equal(mainWindowOptions("/b", "dark", false).webPreferences?.devTools, true);
});

test("title from the brand module, background from the theme's canvas token, hidden until ready", () => {
  const dark = mainWindowOptions("/b", "dark", true);
  const light = mainWindowOptions("/b", "light", true);
  assert.equal(dark.title, windowTitle());
  assert.equal(dark.backgroundColor, PALETTES.dark.canvas);
  assert.equal(light.backgroundColor, PALETTES.light.canvas);
  assert.notEqual(dark.backgroundColor, light.backgroundColor);
  assert.equal(dark.show, false);
});
