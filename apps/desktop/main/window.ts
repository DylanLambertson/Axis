// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The main window's construction options, kept pure (no Electron at run time) so they are tested without Electron. The web
// preferences are @axis/desktop-main's (OS-2): sandboxed, isolated, the app partition, DevTools only unpackaged.
import type { BrowserWindowConstructorOptions, WebPreferences } from "electron";
import { join } from "node:path";
import { appWebPreferences } from "@axis/desktop-main";
import { PALETTES, windowTitle, type ThemeKind } from "@axis/ui";

/** `bundleDir` is the bundle's root (dist/app), which holds preload.cjs. */
export function mainWindowOptions(bundleDir: string, theme: ThemeKind, packaged: boolean): BrowserWindowConstructorOptions {
  return {
    title: windowTitle(),
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    show: false,
    backgroundColor: PALETTES[theme].canvas,
    webPreferences: { ...appWebPreferences({ preload: join(bundleDir, "preload.cjs"), packaged }) } as WebPreferences,
  };
}
