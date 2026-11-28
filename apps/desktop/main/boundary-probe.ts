// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The boundary probe (smoke/boundary.test.mjs): with AXIS_DESKTOP_SMOKE=boundary in an UNPACKAGED build, main runs PAGE_BOUNDARY
// in the app window's main world (with a user gesture, so the clipboard write is a real copy), tries to navigate the window
// away, and asks an unregistered second window for openExternal; then it prints one line `AXIS_DESKTOP_BOUNDARY <json>` and quits.
// A packaged build never runs it.

export const BOUNDARY_MARKER = "AXIS_DESKTOP_BOUNDARY";

/** Evaluated in the page's main world; resolves to a flat record of what the page could and could not do. */
export const PAGE_BOUNDARY = `(async () => {
  const r = {};
  const settle = (p, ms = 3000) => Promise.race([p, new Promise((res) => setTimeout(() => res("timeout"), ms))]);
  const fetchState = async (u) => { try { await fetch(u); return "ok"; } catch { return "refused"; } };
  r.fetchHttps = await fetchState("https://example.com/");
  r.fetchLoopback = await fetchState("http://127.0.0.1:9/");
  r.fetchSelf = await fetchState("./index.html");
  r.websocket = await settle(new Promise((res) => { try { const s = new WebSocket("ws://127.0.0.1:9/"); s.onopen = () => res("open"); s.onerror = () => res("refused"); } catch { res("refused"); } }));
  r.dataImage = await settle(new Promise((res) => { const i = new Image(); i.onload = () => res("loaded"); i.onerror = () => res("refused"); i.src = "data:image/gif;base64,R0lGODlhAQABAAAAACw="; }));
  r.remoteImage = await settle(new Promise((res) => { const i = new Image(); i.onload = () => res("loaded"); i.onerror = () => res("refused"); i.src = "https://example.com/a.png"; }));
  try { const s = document.createElement("script"); s.textContent = "window.__axisInline = 1"; document.head.append(s); } catch {}
  r.inlineScript = window.__axisInline === 1 ? "ran" : "refused";
  try { r.eval = (0, eval)("1") === 1 ? "ran" : "refused"; } catch { r.eval = "refused"; }
  const frame = document.createElement("iframe");
  const frameDone = new Promise((res) => { frame.onload = () => res("load"); frame.onerror = () => res("error"); });
  frame.src = "axis-app://shell/index.html";
  document.body.append(frame);
  r.subframeSettled = await settle(frameDone, 10000);
  try { r.subframeAxis = frame.contentWindow && frame.contentWindow.axis !== undefined ? "reachable" : "none"; } catch { r.subframeAxis = "none"; }
  try { r.subframeLoaded = frame.contentDocument && frame.contentDocument.documentElement.dataset.axisShell === "mounted" ? "mounted" : "blocked"; } catch { r.subframeLoaded = "blocked"; }
  frame.remove();
  r.windowOpen = window.open("axis-app://shell/index.html") === null ? "denied" : "opened";
  r.windowOpenHttps = window.open("https://example.com/") === null ? "denied" : "opened";
  // A copy needs a focused document. Retried (at most 3 times) only while the document lacks focus, so a refusal of a focused
  // page still fails at once; clipboard-read is never retried.
  r.clipboardWrite = "refused";
  for (let i = 0; i < 3; i++) {
    r.clipboardWrite = await navigator.clipboard.writeText("axis boundary probe").then(() => "ok", () => "refused");
    if (r.clipboardWrite === "ok" || document.hasFocus()) break;
    await new Promise((res) => setTimeout(res, 300));
  }
  r.clipboardFocusRetries = r.clipboardWrite === "ok" ? "settled" : (document.hasFocus() ? "focused" : "unfocused");
  r.clipboardRead = await navigator.clipboard.readText().then(() => "ok", () => "refused");
  r.geolocation = await settle(new Promise((res) => navigator.geolocation.getCurrentPosition(() => res("ok"), () => res("refused"))));
  const axis = window.axis;
  r.axisFrozen = typeof axis === "object" && axis !== null && Object.isFrozen(axis);
  r.axisKeys = axis ? Object.keys(axis).sort().join(",") : "";
  r.nodeGlobals = typeof require !== "undefined" || typeof process !== "undefined" || typeof module !== "undefined";
  r.openExternalScheme = JSON.stringify(await axis.openExternal("javascript:alert(1)"));
  r.openExternalFile = JSON.stringify(await axis.openExternal("file:///etc/passwd"));
  r.openExternalMailto = JSON.stringify(await axis.openExternal("mailto:a@b.example?attach=/etc/passwd"));
  return r;
})()`;

export interface BoundaryWindow {
  focus?(): void;
  readonly webContents: {
    executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
    getURL(): string;
    on(event: "will-frame-navigate" | "console-message", listener: (...args: never[]) => void): unknown;
    removeListener(event: "will-frame-navigate" | "console-message", listener: (...args: never[]) => void): unknown;
  };
}

const NAVIGATION_CAP_MS = 10_000;

/**
 * Asks the page to navigate to `target` and waits, up to a generous cap, for main to see the attempt (`will-frame-navigate`,
 * which our policy prevents; Electron 45 may report `did-start-navigation` first, and that alone does not settle it). "none" (no
 * attempt seen within the cap) fails the test: a slow run fails, it never passes falsely. The URL is read after a short settle.
 */
async function attemptNavigation(win: BoundaryWindow, target: string, wait: (ms: number) => Promise<void>): Promise<string> {
  const seen = new Promise<string>((res) => {
    const done = (what: string): void => {
      win.webContents.removeListener("will-frame-navigate", onWill);
      win.webContents.removeListener("console-message", onConsole);
      res(what);
    };
    const onWill = (): void => done("attempted");
    // Chromium refuses a file: navigation from the app origin in the renderer, so main never sees it; its console line is the proof.
    const onConsole = (...args: never[]): void => {
      const first = args[0] as unknown as { message?: unknown } | undefined;
      const text = String(first?.message ?? args[2] ?? "");
      if (text.includes("Not allowed to load local resource")) done("renderer-refused");
    };
    win.webContents.on("will-frame-navigate", onWill);
    win.webContents.on("console-message", onConsole);
    void wait(NAVIGATION_CAP_MS).then(() => done("none"));
  });
  await win.webContents.executeJavaScript(`setTimeout(() => { location.href = ${JSON.stringify(target)}; }, 0); 1`, true).catch(() => undefined);
  const what = await seen;
  await wait(500);
  return `${what}:${win.webContents.getURL()}`;
}

export interface BoundaryDeps {
  readonly app: BoundaryWindow;
  /** A second window on the same session and preload that main did NOT register. */
  readonly unregistered: () => Promise<BoundaryWindow>;
  readonly wait: (ms: number) => Promise<void>;
}

export async function runBoundaryProbe(deps: BoundaryDeps): Promise<Record<string, unknown>> {
  // Focus first, bounded: under load another window can hold focus for a moment, and the copy check needs it.
  let focused = false;
  for (let i = 0; i < 20 && !focused; i++) {
    deps.app.focus?.();
    focused = (await deps.app.webContents.executeJavaScript("document.hasFocus()", false)) === true;
    if (!focused) await deps.wait(100);
  }
  const page = { focused, ...((await deps.app.webContents.executeJavaScript(PAGE_BOUNDARY, true)) as Record<string, unknown>) };
  const urlBefore = deps.app.webContents.getURL();
  const navigation: Record<string, string> = {};
  for (const target of ["https://example.com/", "axis-app://shell/other.html", "file:///etc/passwd"]) navigation[target] = await attemptNavigation(deps.app, target, deps.wait);
  const second = await deps.unregistered();
  const secondAnswer = await second.webContents.executeJavaScript(`window.axis.openExternal("https://example.com/").then(JSON.stringify)`, true).catch(() => "threw");
  const secondNavigation = await attemptNavigation(second, "https://example.com/", deps.wait);
  return { ...page, urlBefore, navigation, urlAfterNavigation: deps.app.webContents.getURL(), secondWindowOpenExternal: secondAnswer, secondNavigation };
}
