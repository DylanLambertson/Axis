// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The main window's construction options, kept pure (no Electron at run time) so they are tested without Electron.
// OS-2 adds the session hardening (the app scheme, CSP header, navigation, window-open and permission policy).
import type { BrowserWindowConstructorOptions } from "electron";
import { join } from "node:path";
import { PALETTES, windowTitle, type ThemeKind } from "@axis/ui";

/** `bundleDir` is the bundle's root (dist/app), which holds preload.cjs. */
export function mainWindowOptions(bundleDir: string, theme: ThemeKind): BrowserWindowConstructorOptions {
  return {
    title: windowTitle(),
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    show: false,
    backgroundColor: PALETTES[theme].canvas,
    webPreferences: {
      preload: join(bundleDir, "preload.cjs"),
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
    },
  };
}
