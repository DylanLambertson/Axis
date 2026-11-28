// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// OS-2 wiring: main hands the Electron objects to the pure modules of @axis/desktop-main (ADR 0011 Decision 2). Every function
// takes the objects it uses as parameters (structural types), so test/hardening.test.ts runs it under plain Node.
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  APP_SCHEME,
  APP_URL,
  DEBUG_FLAG_EXIT,
  INTERNAL_APP_NAME,
  IPC_CHANNELS,
  appSchemeRegistration,
  buildCsp,
  createAppSchemeHandler,
  debugFlagRefusals,
  hardenSession,
  hardenWebContents,
  installSchemeFilter,
  parseOpenExternal,
  userDataDir,
  userDataOverlapsDataRoot,
  utilityForkOptions,
  type AppSender,
  type DesktopPlatform,
  type ExternalOutcome,
  type SessionLike,
  type UtilityServiceName,
  type WebContentsLike,
  type WebRequestLike,
  type WindowRegistry,
} from "@axis/desktop-main";

/**
 * G-28: the first thing main does. A packaged build given a debugging switch (any form) or `ELECTRON_RUN_AS_NODE` or
 * `NODE_OPTIONS` exits 64 at once and names the switch, never its value. Returns true when it refused. `--inspect` opens before
 * this runs, so the `EnableNodeCliInspectArguments` fuse (OS-21) is what closes that one.
 */
export function refuseDebugging(
  facts: { readonly argv: readonly string[]; readonly env: Readonly<Record<string, string | undefined>>; readonly packaged: boolean; readonly platform: DesktopPlatform },
  exit: (code: number) => void,
  log: (line: string) => void,
): boolean {
  const refused = debugFlagRefusals(facts.argv, facts.env, { packaged: facts.packaged, platform: facts.platform });
  if (refused.length === 0) return false;
  log(`refused debugging switches in a packaged build: ${refused.join(", ")}`);
  exit(DEBUG_FLAG_EXIT);
  return true;
}

export interface AppPathsLike {
  setName(name: string): void;
  getPath(name: "appData"): string;
  setPath(name: "userData", path: string): void;
}

/**
 * Before `ready`: the privileged app scheme, then the internal app name and `userData` (stable ids, never from the brand). Throws
 * when `userData` would meet the daemon's data roots (`dataBase`, the parent of `axisDataRoots(...).dataDir`); nothing is set
 * then. `userDataOverride` is an unpackaged run's `--user-data-dir` (the smoke test): it is checked the same way.
 */
export function prepareBeforeReady(deps: {
  readonly app: AppPathsLike;
  readonly protocol: { registerSchemesAsPrivileged(schemes: Array<{ scheme: string; privileges: { [name: string]: boolean } }>): void };
  readonly platform: DesktopPlatform;
  readonly dataBase: string;
  readonly userDataOverride?: string;
  /** Resolves links (default `realpathSync.native`); throws when the path does not exist. */
  readonly realpath?: (path: string) => string;
}): string {
  deps.protocol.registerSchemesAsPrivileged(appSchemeRegistration().map((s) => ({ scheme: s.scheme, privileges: { ...s.privileges } })));
  const userData = deps.userDataOverride ?? userDataDir(deps.app.getPath("appData"), deps.platform);
  if (!isAbsolute(userData)) throw new Error("userData must be an absolute path");
  const real = (p: string): string => resolveExisting(p, deps.realpath ?? realpathSync.native);
  if (userDataOverlapsDataRoot(real(userData), real(deps.dataBase), deps.platform) || userDataOverlapsDataRoot(userData, deps.dataBase, deps.platform)) {
    throw new Error("userData would overlap the daemon data roots");
  }
  deps.app.setName(INTERNAL_APP_NAME);
  deps.app.setPath("userData", userData);
  return userData;
}

/**
 * `path.resolve`, then the real path of the deepest ancestor that exists with the rest appended: a link (or a Windows short name)
 * on the way cannot hide that two paths meet, even before either directory is created.
 */
export function resolveExisting(path: string, realpath: (path: string) => string): string {
  let head = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpath(head), ...rest.reverse());
    } catch {
      const up = dirname(head);
      if (up === head) return resolve(path);
      rest.push(basename(head));
      head = up;
    }
  }
}

/** Throws unless every named member is a function: a renamed Electron API must fail at startup, not silently install nothing. */
export function requireApis(target: unknown, names: readonly string[], what: string): void {
  const missing = names.filter((n) => typeof (target as Record<string, unknown> | null)?.[n] !== "function");
  if (missing.length > 0) throw new Error(`${what} lacks ${missing.join(", ")}`);
}

export const SESSION_APIS = Object.freeze(["setPermissionRequestHandler", "setPermissionCheckHandler", "setDevicePermissionHandler", "setDisplayMediaRequestHandler", "setSpellCheckerEnabled", "on", "listenerCount"]);
export const CONTENTS_APIS = Object.freeze(["on", "setWindowOpenHandler", "listenerCount"]);

/**
 * Device choosers: with a listener that forgets `preventDefault`, Electron picks the first device. None may exist; the check
 * handler already refuses `hid`, `serial` and `usb`, and Bluetooth with no listener cancels.
 */
export const SESSION_CHOOSER_EVENTS = Object.freeze(["select-hid-device", "select-serial-port", "select-usb-device"]);
export const CONTENTS_CHOOSER_EVENTS = Object.freeze(["select-bluetooth-device"]);

export function assertNoChoosers(target: { listenerCount(event: string): number }, events: readonly string[], what: string): void {
  const heard = events.filter((e) => target.listenerCount(e) !== 0);
  if (heard.length > 0) throw new Error(`${what} has a device chooser listener: ${heard.join(", ")}`);
}

export interface AppSessionLike extends SessionLike {
  listenerCount(event: string): number;
  readonly protocol: { handle(scheme: string, handler: (request: Request) => Promise<Response>): void };
  readonly webRequest: WebRequestLike;
}

export type HardeningEvent = { readonly kind: "policy"; readonly what: string } | { readonly kind: "request"; readonly scheme: string } | { readonly kind: "scheme"; readonly status: number };

/** The app windows' session: the `axis-app` handler over the bundle root, the permission and download policy, the request filter. */
export function hardenAppSession(session: AppSessionLike, options: { readonly bundleRoot: string; readonly packaged: boolean; readonly onEvent?: (event: HardeningEvent) => void }): void {
  const emit = options.onEvent ?? (() => {});
  requireApis(session, SESSION_APIS, "the app session");
  requireApis(session.protocol, ["handle"], "the app session's protocol");
  requireApis(session.webRequest, ["onBeforeRequest"], "the app session's webRequest");
  assertNoChoosers(session, SESSION_CHOOSER_EVENTS, "the app session");
  const handler = createAppSchemeHandler({ root: options.bundleRoot, csp: buildCsp({ trustedTypesPolicies: [] }), onRefused: (status) => emit({ kind: "scheme", status }) });
  session.protocol.handle(APP_SCHEME, async (request) => {
    const r = await handler.handle({ url: request.url, method: request.method });
    return new Response(r.body === null ? null : new Uint8Array(r.body), { status: r.status, headers: r.headers });
  });
  hardenSession(session, (what) => emit({ kind: "policy", what }));
  installSchemeFilter(session.webRequest, { devtools: !options.packaged, onRefused: (scheme) => emit({ kind: "request", scheme }) });
}

export interface AppWindowLike {
  readonly webContents: WebContentsLike & { readonly id: number; listenerCount(event: string): number };
  on(event: "closed", listener: () => void): unknown;
  loadURL(url: string): Promise<void>;
}

/**
 * Creates a window, registers it, hardens its web contents and loads the app URL. A window the registry refuses (the cap) is
 * not loaded. The registry entry is pruned on `closed`.
 */
export async function openAppWindow<W extends AppWindowLike, O>(deps: {
  readonly create: (options: O) => W;
  readonly options: O;
  readonly registry: WindowRegistry;
  readonly onEvent?: (event: HardeningEvent) => void;
}): Promise<{ readonly id: number; readonly window: W }> {
  const win = deps.create(deps.options);
  requireApis(win.webContents, CONTENTS_APIS, "the window's web contents");
  assertNoChoosers(win.webContents, CONTENTS_CHOOSER_EVENTS, "the window's web contents");
  hardenWebContents(win.webContents, (what) => deps.onEvent?.({ kind: "policy", what }));
  const entry = deps.registry.add(win.webContents.id);
  if (entry === undefined) throw new Error("the window registry is full");
  win.on("closed", () => deps.registry.close(entry.id));
  await win.loadURL(APP_URL);
  return { id: entry.id, window: win };
}

interface FrameLike {
  readonly url: string;
  readonly parent: unknown;
}

/** What the sender checks read from an IPC event. A missing frame has no URL and is not a main frame. */
export function senderOf(event: { readonly sender: { readonly id: number; isDestroyed(): boolean }; readonly senderFrame: FrameLike | null | undefined }): AppSender {
  const frame = event.senderFrame ?? undefined;
  return { webContentsId: event.sender.id, frameUrl: frame?.url, isMainFrame: frame !== undefined && frame.parent === null, destroyed: event.sender.isDestroyed() };
}

/** `axis:openExternal`: the sender checks first, then the exact payload, then EL-5 (the opener draws the confirmation). */
export function registerOpenExternal<E extends Parameters<typeof senderOf>[0]>(deps: {
  readonly ipcMain: { handle(channel: string, listener: (event: E, ...args: unknown[]) => Promise<ExternalOutcome>): void };
  readonly registry: WindowRegistry;
  readonly opener: { open(windowId: number, input: unknown): Promise<ExternalOutcome>; windowClosed(windowId: number): void };
}): void {
  deps.registry.onClosed((id) => deps.opener.windowClosed(id));
  deps.ipcMain.handle(IPC_CHANNELS.openExternal, async (event, ...args) => {
    const payload = args[0];
    const id = deps.registry.checkAppSender(senderOf(event));
    if (typeof id !== "number") return { ok: false, reason: "no_window" };
    return deps.opener.open(id, parseOpenExternal(payload));
  });
}

/** `utilityProcess.fork` of the daemon or the pty entry with the fixed options (fork-options.ts). The entry is main's own path. */
export function forkUtility<C>(
  utilityProcess: { fork(entry: string, args: string[], options: ReturnType<typeof utilityForkOptions>): C },
  entry: string,
  serviceName: UtilityServiceName,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  platform: DesktopPlatform,
): C {
  if (!isAbsolute(entry)) throw new Error("the utility entry must be an absolute path");
  return utilityProcess.fork(entry, [], utilityForkOptions(serviceName, env, cwd, platform));
}
