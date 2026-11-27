// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Electron main of the own shell (OS-1 scaffold): one window over the bundled renderer. The window registry, the
// app scheme and the session hardening are OS-2; the daemon seam is OS-3.
import { app, BrowserWindow, nativeTheme } from "electron";
import { join } from "node:path";
import { mainWindowOptions } from "./window.js";
import { PAGE_PROBE, smokeLine, smokeReport } from "./smoke.js";

const SMOKE = process.env.AXIS_DESKTOP_SMOKE === "1";

function bundleDir(): string {
  return join(app.getAppPath(), "dist", "app");
}

async function openMainWindow(): Promise<void> {
  const dir = bundleDir();
  const win = new BrowserWindow(mainWindowOptions(dir, nativeTheme.shouldUseDarkColors ? "dark" : "light"));
  win.once("ready-to-show", () => win.show());
  await win.loadFile(join(dir, "renderer", "index.html"));
  if (!SMOKE) return;
  const report = await smokeReport({
    title: () => win.getTitle(),
    probe: () => win.webContents.executeJavaScript(PAGE_PROBE, false) as Promise<unknown>,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  process.stdout.write(`${smokeLine(report)}\n`);
  app.exit(report.mounted && !report.nodeInPage ? 0 : 1);
}

app.on("window-all-closed", () => app.quit());
app.whenReady().then(openMainWindow).catch((error: unknown) => {
  process.stderr.write(`main window failed: ${error instanceof Error ? error.message : String(error)}\n`);
  app.exit(1);
});
