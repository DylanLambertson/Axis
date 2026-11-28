// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { isAppOrigin } from "./stable-ids.js";

/**
 * The app window's web preferences and its navigation, window-open and permission policy (ADR 0011 Decision 2; threat model EL-1,
 * EL-3, EL-5). Electron is injected through the structural types below, so this file runs under plain Node in tests.
 *
 * - Every navigation, frame navigation and redirect is refused; main loads `APP_URL` itself and nothing may move a frame off it.
 *   A link the user should follow goes through the preload's `openExternal` and main's EL-5 decision, never `window.open`.
 * - `window.open` and every new window are denied; a `<webview>` is never attached (and `webviewTag` is off).
 * - Every permission request and check is denied except `clipboard-sanitized-write` from the app origin (copy in Monaco and
 *   xterm.js; a request also needs the main frame). `clipboard-read` stays denied, so paste works only through the native paste
 *   event. Device permissions, display capture and downloads are refused, and the spell checker is off (it would download
 *   dictionaries from the network).
 */

/** The one permission the app window may use. */
export const ALLOWED_PERMISSION = "clipboard-sanitized-write";

/** `BrowserWindow`'s `webPreferences` for an app window. The preload path is main's own, absolute. */
export function appWebPreferences(options: { readonly preload: string; readonly packaged: boolean }): Readonly<Record<string, unknown>> {
  if (typeof options.preload !== "string" || options.preload === "" || options.preload.includes("\0") || !(options.preload.startsWith("/") || /^[A-Za-z]:\\/.test(options.preload))) {
    throw new Error("appWebPreferences: preload must be an absolute path");
  }
  return Object.freeze({
    preload: options.preload,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    safeDialogs: true,
    devTools: !options.packaged,
  });
}

/** True only for the one allowed permission, from the app origin (and, for a request, its main frame). */
export function permissionAllowed(permission: string, requestingUrl: string | undefined, isMainFrame: boolean | undefined): boolean {
  return permission === ALLOWED_PERMISSION && isAppOrigin(requestingUrl) && isMainFrame !== false;
}

interface PreventableEvent {
  preventDefault(): void;
}

/** The part of Electron's `WebContents` the policy uses. */
export interface WebContentsLike {
  on(event: "will-navigate" | "will-frame-navigate" | "will-redirect" | "will-attach-webview", listener: (event: PreventableEvent, ...rest: unknown[]) => void): unknown;
  setWindowOpenHandler(handler: (details: unknown) => { action: "deny" }): void;
}

/** The part of Electron's `Session` the policy uses. Optional members are older or platform-specific Electron APIs. */
export interface SessionLike {
  setPermissionRequestHandler(handler: ((webContents: unknown, permission: string, callback: (granted: boolean) => void, details: { requestingUrl?: string; isMainFrame?: boolean }) => void) | null): void;
  setPermissionCheckHandler(handler: ((webContents: unknown, permission: string, requestingOrigin: string, details: { requestingUrl?: string; isMainFrame?: boolean }) => boolean) | null): void;
  setDevicePermissionHandler?(handler: (details: unknown) => boolean): void;
  setDisplayMediaRequestHandler?(handler: ((request: unknown, callback: (streams: Record<string, never>) => void) => void) | null): void;
  setSpellCheckerEnabled?(enabled: boolean): void;
  on(event: "will-download", listener: (event: PreventableEvent, ...rest: unknown[]) => void): unknown;
}

export type PolicyRefusal = "navigation" | "frame_navigation" | "redirect" | "webview" | "window_open" | "permission" | "download";

/** Installs the navigation and window-open policy on an app window's `webContents`. `onRefused` gets a closed name, never a URL. */
export function hardenWebContents(contents: WebContentsLike, onRefused: (what: PolicyRefusal) => void = () => {}): void {
  const deny = (what: PolicyRefusal) => (event: PreventableEvent) => {
    event.preventDefault();
    onRefused(what);
  };
  contents.on("will-navigate", deny("navigation"));
  contents.on("will-frame-navigate", deny("frame_navigation"));
  contents.on("will-redirect", deny("redirect"));
  contents.on("will-attach-webview", deny("webview"));
  contents.setWindowOpenHandler(() => {
    onRefused("window_open");
    return { action: "deny" };
  });
}

/** Installs the permission, device, display-capture, download and spell-checker policy on the app windows' session. */
export function hardenSession(session: SessionLike, onRefused: (what: PolicyRefusal) => void = () => {}): void {
  session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const ok = permissionAllowed(permission, details?.requestingUrl, details?.isMainFrame === true);
    if (!ok) onRefused("permission");
    callback(ok);
  });
  // A check has no frame flag that means "main frame" on every version, so only the origin is required; the request (which is
  // what actually grants a write) also needs the main frame.
  session.setPermissionCheckHandler((_wc, permission, requestingOrigin) => permissionAllowed(permission, requestingOrigin, undefined));
  session.setDevicePermissionHandler?.(() => false);
  session.setDisplayMediaRequestHandler?.((_request, callback) => {
    onRefused("permission");
    callback({});
  });
  session.setSpellCheckerEnabled?.(false);
  session.on("will-download", (event) => {
    event.preventDefault();
    onRefused("download");
  });
}
