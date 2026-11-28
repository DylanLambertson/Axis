// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The web preferences, the navigation, window-open and permission policy, and the webRequest scheme filter. Mutants each test kills:
//   W1 a web preference loosened (the whole object is pinned); W2 DevTools on in a packaged build; W3 a relative preload;
//   W4 a navigation, frame navigation, redirect or webview not prevented; W5 window.open allowed; W6 any permission but
//   clipboard-sanitized-write granted (clipboard-read above all); W7 the allowed permission granted to another origin or, for a
//   request, a subframe; W8 the device, display-capture, download or spell-checker policy not installed;
//   F1 a non-app URL let through (http, https, ws, file, data, blob, chrome, devtools in a packaged build); F2 the refusal
//   callback given the URL instead of the scheme; F3 the filter narrower than every URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_PERMISSION, WEB_REQUEST_FILTER, appWebPreferences, hardenSession, hardenWebContents, installSchemeFilter, permissionAllowed,
  webRequestAllowed, type SessionLike, type WebContentsLike,
} from "../src/index.js";

test("web preferences are pinned", () => {
  const base = {
    preload: "/opt/app/preload.js", partition: "axis-shell", sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false,
    navigateOnDragDrop: false, spellcheck: false, safeDialogs: true,
  };
  assert.deepEqual(appWebPreferences({ preload: "/opt/app/preload.js", packaged: true }), { ...base, devTools: false }, "W1/W2");
  assert.deepEqual(appWebPreferences({ preload: "/opt/app/preload.js", packaged: false }), { ...base, devTools: true });
  assert.equal(appWebPreferences({ preload: "C:\\app\\preload.js", packaged: true })["preload"], "C:\\app\\preload.js");
  for (const p of ["preload.js", "", "./p.js", "/a\0b"]) assert.throws(() => appWebPreferences({ preload: p, packaged: true }), `W3: ${p}`);
});

function fakeContents(): { contents: WebContentsLike; listeners: Map<string, (e: { preventDefault(): void }) => void>; open: () => unknown } {
  const listeners = new Map<string, (e: { preventDefault(): void }) => void>();
  let handler: ((d: unknown) => unknown) | undefined;
  return {
    listeners,
    open: () => handler?.({ url: "https://example.com/" }),
    contents: {
      on: (event, listener) => void listeners.set(event, listener),
      setWindowOpenHandler: (h) => void (handler = h),
    },
  };
}

test("navigation, frame navigation, redirects, webviews and window.open are refused", () => {
  const f = fakeContents();
  const refused: string[] = [];
  hardenWebContents(f.contents, (w) => refused.push(w));
  for (const ev of ["will-navigate", "will-frame-navigate", "will-redirect", "will-attach-webview"]) {
    let prevented = false;
    const l = f.listeners.get(ev);
    assert.ok(l, `W4: ${ev} not handled`);
    l({ preventDefault: () => void (prevented = true) });
    assert.equal(prevented, true, `W4: ${ev}`);
  }
  assert.deepEqual(f.open(), { action: "deny" }, "W5");
  assert.deepEqual(refused, ["navigation", "frame_navigation", "redirect", "webview", "window_open"]);
});

test("permissionAllowed: only clipboard-sanitized-write from the app origin's main frame", () => {
  assert.equal(ALLOWED_PERMISSION, "clipboard-sanitized-write");
  assert.equal(permissionAllowed("clipboard-sanitized-write", "axis-app://shell/index.html", true), true);
  for (const p of ["clipboard-read", "media", "geolocation", "notifications", "fullscreen", "openExternal", "pointerLock", "hid", "serial", "usb", "unknown", ""]) {
    assert.equal(permissionAllowed(p, "axis-app://shell/index.html", true), false, `W6: ${p}`);
  }
  for (const u of ["https://evil.example/", "axis-app://other/", "file:///", undefined]) {
    assert.equal(permissionAllowed("clipboard-sanitized-write", u, true), false, `W7: ${String(u)}`);
  }
  assert.equal(permissionAllowed("clipboard-sanitized-write", "axis-app://shell/index.html", false), false, "W7: subframe");
});

test("hardenSession installs every handler", () => {
  const got: Record<string, unknown> = {};
  let spell: boolean | undefined;
  const session: SessionLike = {
    setPermissionRequestHandler: (h) => void (got["request"] = h),
    setPermissionCheckHandler: (h) => void (got["check"] = h),
    setDevicePermissionHandler: (h) => void (got["device"] = h),
    setDisplayMediaRequestHandler: (h) => void (got["display"] = h),
    setSpellCheckerEnabled: (e) => void (spell = e),
    on: (event, l) => void (got[event] = l),
  };
  const refused: string[] = [];
  hardenSession(session, (w) => refused.push(w));
  const request = got["request"] as Parameters<SessionLike["setPermissionRequestHandler"]>[0];
  const check = got["check"] as Parameters<SessionLike["setPermissionCheckHandler"]>[0];
  assert.ok(request && check);
  const answers: boolean[] = [];
  request({}, "clipboard-sanitized-write", (g) => answers.push(g), { requestingUrl: "axis-app://shell/index.html", isMainFrame: true });
  request({}, "clipboard-sanitized-write", (g) => answers.push(g), { requestingUrl: "axis-app://shell/index.html" });
  request({}, "clipboard-read", (g) => answers.push(g), { requestingUrl: "axis-app://shell/index.html", isMainFrame: true });
  assert.deepEqual(answers, [true, false, false], "W6/W7: a request without the main-frame flag is refused");
  assert.equal(check(null, "clipboard-sanitized-write", "axis-app://shell/", { isMainFrame: true, requestingUrl: "axis-app://shell/index.html" }), true);
  assert.equal(check(null, "clipboard-sanitized-write", "axis-app://shell", {}), false, "W7: a check without the main-frame flag");
  assert.equal(check(null, "clipboard-sanitized-write", "axis-app://shell", { isMainFrame: false }), false, "W7: a subframe's check");
  assert.equal(check(null, "clipboard-sanitized-write", "axis-app://shell", { isMainFrame: true, embeddingOrigin: "https://x" }), false, "W7: embedded elsewhere");
  assert.equal(check(null, "clipboard-sanitized-write", "axis-app://shell", { isMainFrame: true, embeddingOrigin: "axis-app://shell" }), true);
  assert.equal(check(null, "clipboard-read", "axis-app://shell", { isMainFrame: true }), false, "W6");
  assert.equal(check(null, "clipboard-sanitized-write", "https://x", { isMainFrame: true }), false, "W7");
  assert.equal((got["device"] as () => boolean)(), false, "W8");
  let streams: unknown = "unset";
  (got["display"] as (r: unknown, cb: (s: unknown) => void) => void)({}, (s) => void (streams = s));
  assert.deepEqual(streams, {}, "W8");
  assert.equal(spell, false, "W8");
  let prevented = false;
  (got["will-download"] as (e: { preventDefault(): void }) => void)({ preventDefault: () => void (prevented = true) });
  assert.equal(prevented, true, "W8");
  assert.deepEqual(refused, ["permission", "permission", "permission", "download"]);
});

test("webRequest filter: only the app origin (and devtools unpackaged)", () => {
  assert.deepEqual(WEB_REQUEST_FILTER, { urls: ["<all_urls>"] }, "F3");
  assert.equal(webRequestAllowed("axis-app://shell/chunks/a.js", { devtools: false }), true);
  for (const u of ["https://api.example/", "http://127.0.0.1:1/", "ws://x/", "wss://x/", "file:///etc/passwd", "data:text/html,x", "blob:axis-app://shell/1", "chrome://gpu", "devtools://devtools/x", "axis-app://other/a.js", "axis-app://u@shell/a.js", 7, ""]) {
    assert.equal(webRequestAllowed(u, { devtools: false }), false, `F1: ${String(u)}`);
  }
  assert.equal(webRequestAllowed("devtools://devtools/bundled/x.html", { devtools: true }), true);
  assert.equal(webRequestAllowed("https://x/", { devtools: true }), false);
  let listener: ((d: { url: string }, cb: (r: { cancel: boolean }) => void) => void) | undefined;
  const schemes: string[] = [];
  installSchemeFilter({ onBeforeRequest: (_f, l) => void (listener = l) }, { devtools: false, onRefused: (s) => schemes.push(s) });
  assert.ok(listener);
  const out: boolean[] = [];
  listener({ url: "https://secret.example/?token=abc" }, (r) => out.push(r.cancel));
  listener({ url: "axis-app://shell/index.html" }, (r) => out.push(r.cancel));
  listener({ url: "%%" }, (r) => out.push(r.cancel));
  assert.deepEqual(out, [true, false, true]);
  assert.deepEqual(schemes, ["https", "invalid"], "F2");
});
