// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { posix, win32 } from "node:path";

/**
 * The fixed internal ids of the desktop app's main process (ADR 0011 Decision 2, "Stable ids"). None of them is derived from
 * the display brand, so a rebrand (display strings, icons, colours) cannot move the renderer origin, the `userData` directory or
 * the `safeStorage` keychain entry Electron derives from the app name. OS-28 moves every stable id into one module the brand
 * module cannot import; this file holds the ones main needs before `ready`.
 */

/** The privileged scheme the app window is served from (`protocol.handle`). Never `file:`. */
export const APP_SCHEME = "axis-app";
/** The one host of the app scheme. */
export const APP_HOST = "shell";
/** The renderer origin, as Chromium serialises it for a standard scheme. */
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
/** The one document main loads into an app window. A sender frame must have exactly this URL (window-registry.ts). */
export const APP_URL = `${APP_ORIGIN}/index.html`;

/**
 * The app windows' session partition: their own, in memory (no `persist:`), so the scheme filter, the permission policy and the
 * spell-checker setting never touch `defaultSession` (main's own `net`, any other web contents), and nothing a page stores
 * outlives the run. Durable state lives in the daemon.
 */
export const APP_PARTITION = "axis-shell";

/**
 * The Electron app name, set with `app.setName` before `ready`. Lower case and distinct from the data roots' `Axis` directory
 * (`axisDataRoots`): on macOS `appData` is `~/Library/Application Support`, the same directory as the data roots' base, and a
 * case-insensitive file system would make `axis` and `Axis` one directory.
 */
export const INTERNAL_APP_NAME = "axis-shell";

/**
 * The privileges main registers for the app scheme with `protocol.registerSchemesAsPrivileged`, before `ready`. `standard` and
 * `secure` give it a real origin and a secure context. `supportFetchAPI` lets the bundle load its own lazy chunks and workers.
 * Nothing bypasses the CSP, there are no service workers, and the scheme is not CORS-enabled, so no other origin can read it.
 */
export const APP_SCHEME_PRIVILEGES = Object.freeze({
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: false,
  bypassCSP: false,
  allowServiceWorkers: false,
  stream: false,
  codeCache: false,
});

/** The argument of `protocol.registerSchemesAsPrivileged`. */
export function appSchemeRegistration(): ReadonlyArray<{ readonly scheme: string; readonly privileges: typeof APP_SCHEME_PRIVILEGES }> {
  return Object.freeze([Object.freeze({ scheme: APP_SCHEME, privileges: APP_SCHEME_PRIVILEGES })]);
}

export type DesktopPlatform = "darwin" | "linux" | "win32";

const isAbsoluteFor = (platform: DesktopPlatform, p: string): boolean =>
  platform === "win32" ? /^[A-Za-z]:\\/.test(p) || /^\\\\[^\\]/.test(p) : p.startsWith("/");

/**
 * The `userData` directory main sets with `app.setPath('userData', ...)` before `ready`: `<appData>/<INTERNAL_APP_NAME>`. `appData`
 * is `app.getPath('appData')`. Throws on a relative path or a NUL, which would put Chromium's profile somewhere unintended.
 */
export function userDataDir(appData: string, platform: DesktopPlatform): string {
  if (typeof appData !== "string" || appData === "" || appData.includes("\0") || !isAbsoluteFor(platform, appData)) {
    throw new Error("userDataDir: appData must be an absolute path");
  }
  const sep = platform === "win32" ? "\\" : "/";
  return `${appData.replace(/[\\/]+$/, "")}${sep}${INTERNAL_APP_NAME}`;
}

/**
 * True when the `userData` directory and the data roots' base (the parent of `axisDataRoots(...).dataDir`) are the same directory
 * or one holds the other. Case-insensitive on macOS and Windows, whose default file systems are. Main refuses to start then: the
 * daemon's data, the anchor and the worktrees must never sit in Chromium's profile, nor the profile in them.
 */
export function userDataOverlapsDataRoot(userData: string, dataBase: string, platform: DesktopPlatform): boolean {
  // `.` and `..` segments and repeated or trailing separators are resolved first; links and Windows short names are main's to
  // resolve (realpath) before it calls this.
  const norm = (p: string): string => {
    const s = (platform === "win32" ? win32.normalize(p) : posix.normalize(p)).replace(/[\\/]+$/, "");
    return platform === "linux" ? s : s.toLowerCase();
  };
  const sep = platform === "win32" ? "\\" : "/";
  const a = norm(userData);
  const b = norm(dataBase);
  return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}

/** True when `url` is on the app origin: the app scheme and host, no credentials and no port. */
export function isAppOrigin(url: string | undefined | null): boolean {
  if (typeof url !== "string" || url === "") return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === `${APP_SCHEME}:` && u.hostname === APP_HOST && u.username === "" && u.password === "" && u.port === "";
}
