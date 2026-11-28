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
  frame.src = "axis-app://shell/index.html";
  document.body.append(frame);
  await new Promise((res) => setTimeout(res, 1000));
  try { r.subframeAxis = frame.contentWindow && frame.contentWindow.axis !== undefined ? "reachable" : "none"; } catch { r.subframeAxis = "none"; }
  try { r.subframeLoaded = frame.contentDocument && frame.contentDocument.documentElement.dataset.axisShell === "mounted" ? "mounted" : "blocked"; } catch { r.subframeLoaded = "blocked"; }
  frame.remove();
  r.windowOpen = window.open("axis-app://shell/index.html") === null ? "denied" : "opened";
  r.windowOpenHttps = window.open("https://example.com/") === null ? "denied" : "opened";
  r.clipboardWrite = await navigator.clipboard.writeText("axis boundary probe").then(() => "ok", () => "refused");
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
  readonly webContents: {
    executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
    getURL(): string;
  };
}

export interface BoundaryDeps {
  readonly app: BoundaryWindow;
  /** A second window on the same session and preload that main did NOT register. */
  readonly unregistered: () => Promise<BoundaryWindow>;
  readonly wait: (ms: number) => Promise<void>;
}

export async function runBoundaryProbe(deps: BoundaryDeps): Promise<Record<string, unknown>> {
  const page = (await deps.app.webContents.executeJavaScript(PAGE_BOUNDARY, true)) as Record<string, unknown>;
  const urlBefore = deps.app.webContents.getURL();
  for (const target of ["https://example.com/", "axis-app://shell/other.html", "file:///etc/passwd"]) {
    await deps.app.webContents.executeJavaScript(`location.href = ${JSON.stringify(target)}; 1`, true).catch(() => undefined);
    await deps.wait(700);
  }
  const second = await deps.unregistered();
  const secondAnswer = await second.webContents.executeJavaScript(`window.axis.openExternal("https://example.com/").then(JSON.stringify)`, true).catch(() => "threw");
  return { ...page, urlBefore, urlAfterNavigation: deps.app.webContents.getURL(), secondWindowOpenExternal: secondAnswer };
}
