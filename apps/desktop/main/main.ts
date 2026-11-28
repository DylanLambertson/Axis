// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Electron main of the own shell, loaded by main/entry.ts only after the G-28 check. OS-1 scaffold; OS-2 wires the window and
// session hardening (main/hardening.ts over @axis/desktop-main, docs/design/own-shell-main-hardening.md); the daemon seam is OS-3.
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, session, shell } from "electron";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { axisDataRoots } from "@axis/daemon-host";
import { APP_PARTITION, APP_URL, WindowRegistry, type DesktopPlatform } from "@axis/desktop-main";
import { createMainExternalOpener, hardenAppSession, installAppHardening, openAppWindow, prepareBeforeReady, registerOpenExternal, type AppSessionLike, type HardeningEvent } from "./hardening.js";
import { mainWindowOptions } from "./window.js";
import { PAGE_PROBE, smokeLine, smokeReport } from "./smoke.js";

const PLATFORM = process.platform as DesktopPlatform;
const PACKAGED = app.isPackaged;
/** The smoke hooks ("1": mount report; "boundary": the boundary probe) run in an unpackaged build only. */
const SMOKE = PACKAGED ? "" : (process.env.AXIS_DESKTOP_SMOKE ?? "");

/** Closed events only (no URL, path or value); written in development builds. */
function log(event: HardeningEvent): void {
  if (!PACKAGED) process.stderr.write(`axis-shell ${JSON.stringify(event)}\n`);
}

function bundleDir(): string {
  return join(app.getAppPath(), "dist", "app");
}

/** An unpackaged run's `--user-data-dir` (the smoke test). A packaged build always takes the internal id. */
function userDataOverride(): string | undefined {
  if (PACKAGED) return undefined;
  const arg = process.argv.find((a) => a.startsWith("--user-data-dir="));
  return arg === undefined ? undefined : arg.slice("--user-data-dir=".length);
}

function start(): void {
  prepareBeforeReady({
    app,
    protocol,
    platform: PLATFORM,
    dataBase: dirname(axisDataRoots(PLATFORM, process.env, homedir()).dataDir),
    ...(userDataOverride() === undefined ? {} : { userDataOverride: userDataOverride() as string }),
  });
  installAppHardening(app as unknown as Parameters<typeof installAppHardening>[0], log, (error) => {
    process.stderr.write(`web contents hardening failed: ${error.message}\n`);
    app.exit(1);
  });
  app.on("window-all-closed", () => app.quit());
  app.whenReady().then(ready).catch((error: unknown) => {
    process.stderr.write(`main window failed: ${error instanceof Error ? error.message : String(error)}\n`);
    app.exit(1);
  });
}

async function ready(): Promise<void> {
  const dir = bundleDir();
  hardenAppSession(session.fromPartition(APP_PARTITION) as unknown as AppSessionLike, { bundleRoot: join(dir, "renderer"), packaged: PACKAGED, onEvent: log });
  const registry = new WindowRegistry();
  const windows = new Map<number, BrowserWindow>();
  registry.onClosed((id) => windows.delete(id));
  const opener = createMainExternalOpener({
    registry,
    windowFor: (id) => {
      const win = windows.get(id);
      return win === undefined || win.isDestroyed() ? undefined : win;
    },
    showMessageBox: (win, options) => dialog.showMessageBox(win, options),
    openExternal: (href) => shell.openExternal(href),
  });
  registerOpenExternal({ ipcMain, registry, opener });
  const { id, window: win } = await openAppWindow({
    create: (options: Electron.BrowserWindowConstructorOptions) => {
      const w = new BrowserWindow(options);
      w.once("ready-to-show", () => w.show());
      return w;
    },
    options: mainWindowOptions(dir, nativeTheme.shouldUseDarkColors ? "dark" : "light", PACKAGED),
    registry,
    onEvent: log,
  });
  windows.set(id, win);
  if (SMOKE !== "1" && SMOKE !== "boundary") return;
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const report = await smokeReport({ title: () => win.getTitle(), probe: () => win.webContents.executeJavaScript(PAGE_PROBE, false) as Promise<unknown>, wait });
  process.stdout.write(`${smokeLine(report)}\n`);
  if (SMOKE === "boundary") {
    const { BOUNDARY_MARKER, runBoundaryProbe } = await import("./boundary-probe.js");
    type Probed = Parameters<typeof runBoundaryProbe>[0]["app"];
    const result = await runBoundaryProbe({
      app: win as unknown as Probed,
      unregistered: async () => {
        const second = new BrowserWindow({ ...mainWindowOptions(dir, "dark", PACKAGED), show: false });
        await second.loadURL(APP_URL);
        return second as unknown as Probed;
      },
      wait,
    });
    process.stdout.write(`${BOUNDARY_MARKER} ${JSON.stringify(result)}\n`);
  }
  app.exit(report.mounted && !report.nodeInPage ? 0 : 1);
}

start();
