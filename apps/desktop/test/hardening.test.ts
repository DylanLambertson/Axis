// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The OS-2 wiring of main (main/hardening.ts) against fakes of the Electron objects it is handed. Mutants each test kills
// (named in the assertion messages):
//   H1 the G-28 refusal skipped, or run on an unpackaged build; H2 the scheme registered without its privileges, or after
//   another step; H3 the app name or userData not set, or set to a directory that overlaps the data roots; H4 the scheme
//   handler, the session policy or the request filter not installed on the window's session; H5 the request filter allowing
//   devtools in a packaged build; H6 a window created without the registry, the web contents policy or the app URL; H7 a
//   closed window left in the registry; H8 the openExternal handler answering a sender that fails the checks, or opening
//   without the confirmation; H9 the fork without the fixed options or with a relative entry; H10 a missing Electron API or a
//   device chooser listener accepted at startup; H11 the overlap check fooled by a link; H12 a web contents created without the
//   policy (the app-wide hook removed), or a client certificate chosen or a login answered; H13 the EL-5 dialog with another
//   default or cancel answer, a link, another text than the confirmed URL, or opening on any answer but Open, or opening
//   another string than the one shown.
import { test } from "node:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { APP_SCHEME, APP_SCHEME_PRIVILEGES, APP_URL, DEBUG_FLAG_EXIT, INTERNAL_APP_NAME, IPC_CHANNELS, UTILITY_EXEC_ARGV, WindowRegistry, createExternalOpener } from "@axis/desktop-main";
import { OPEN_BUTTON, createMainExternalOpener, externalDialogOptions, forkUtility, hardenAppSession, installAppHardening, openAppWindow, prepareBeforeReady, registerOpenExternal, requireApis, resolveExisting, senderOf } from "../main/hardening.js";
import { refuseDebugging } from "../main/g28.js";

test("G-28: a packaged build with a debugging switch exits 64 before anything else; an unpackaged one runs", () => {
  const exits: number[] = [];
  const lines: string[] = [];
  const facts = { argv: ["/app/axis", "--remote-debugging-port=9222"], env: {}, platform: "linux" as const };
  assert.equal(refuseDebugging({ ...facts, packaged: true }, (c) => exits.push(c), (l) => lines.push(l)), true, "H1");
  assert.deepEqual(exits, [DEBUG_FLAG_EXIT], "H1");
  assert.match(lines.join("\n"), /remote-debugging-port/);
  assert.doesNotMatch(lines.join("\n"), /9222/, "the value is never echoed");
  assert.equal(refuseDebugging({ ...facts, packaged: false }, (c) => exits.push(c), () => {}), false, "H1: unpackaged");
  assert.equal(refuseDebugging({ argv: ["/app/axis"], env: { NODE_OPTIONS: "--inspect" }, platform: "linux", packaged: true }, (c) => exits.push(c), () => {}), true, "H1: environment");
  assert.deepEqual(exits, [DEBUG_FLAG_EXIT, DEBUG_FLAG_EXIT]);
});

function fakeApp(appData: string) {
  const calls: string[] = [];
  const paths: Record<string, string> = {};
  return {
    calls,
    paths,
    app: {
      setName: (n: string) => calls.push(`setName ${n}`),
      getPath: (n: "appData") => (n === "appData" ? appData : "?"),
      setPath: (n: "userData", p: string) => {
        calls.push(`setPath ${n}`);
        paths[n] = p;
      },
    },
    protocol: { registerSchemesAsPrivileged: (s: unknown) => calls.push(`register ${JSON.stringify(s)}`) },
  };
}

test("before ready: the privileged scheme first, then the internal name and userData", () => {
  const f = fakeApp("/home/u/.config");
  const userData = prepareBeforeReady({ app: f.app, protocol: f.protocol, platform: "linux", dataBase: "/home/u/.local/share/Axis" });
  assert.equal(userData, "/home/u/.config/axis-shell");
  assert.deepEqual(f.calls, [`register ${JSON.stringify([{ scheme: APP_SCHEME, privileges: APP_SCHEME_PRIVILEGES }])}`, `setName ${INTERNAL_APP_NAME}`, "setPath userData"], "H2/H3");
  assert.equal(f.paths["userData"], "/home/u/.config/axis-shell", "H3");
});

test("before ready: a userData that meets the data roots refuses to start; an unpackaged override is still checked", () => {
  const mac = fakeApp("/Users/u/Library/Application Support");
  assert.equal(prepareBeforeReady({ app: mac.app, protocol: mac.protocol, platform: "darwin", dataBase: "/Users/u/Library/Application Support/Axis" }), "/Users/u/Library/Application Support/axis-shell");
  const f = fakeApp("/home/u/.config");
  assert.throws(() => prepareBeforeReady({ app: f.app, protocol: f.protocol, platform: "linux", dataBase: "/home/u/.config/axis-shell/x" }), /overlap/, "H3");
  assert.equal(f.paths["userData"], undefined, "H3: nothing set");
  const o = fakeApp("/home/u/.config");
  assert.equal(prepareBeforeReady({ app: o.app, protocol: o.protocol, platform: "linux", dataBase: "/d/Axis", userDataOverride: "/tmp/smoke" }), "/tmp/smoke");
  assert.throws(() => prepareBeforeReady({ app: o.app, protocol: o.protocol, platform: "linux", dataBase: "/d/Axis", userDataOverride: "/d/Axis/daemon" }), /overlap/, "H3: override");
  assert.throws(() => prepareBeforeReady({ app: o.app, protocol: o.protocol, platform: "linux", dataBase: "/d/Axis", userDataOverride: "rel" }), /absolute/);
});

function fakeSession() {
  const s = {
    handled: [] as string[],
    filters: [] as Array<(d: { url: string }, cb: (r: { cancel: boolean }) => void) => void>,
    handlers: new Map<string, unknown>(),
    protocol: { handle: (scheme: string, h: (req: Request) => Promise<Response>) => { s.handled.push(scheme); s.handlers.set(`scheme:${scheme}`, h); } },
    webRequest: { onBeforeRequest: (_f: { urls: readonly string[] }, l: (d: { url: string }, cb: (r: { cancel: boolean }) => void) => void) => { s.filters.push(l); } },
    setPermissionRequestHandler: (h: unknown) => { s.handlers.set("request", h); },
    setPermissionCheckHandler: (h: unknown) => { s.handlers.set("check", h); },
    setDevicePermissionHandler: (h: unknown) => { s.handlers.set("device", h); },
    setDisplayMediaRequestHandler: (h: unknown) => { s.handlers.set("display", h); },
    setSpellCheckerEnabled: (on: boolean) => { s.handlers.set("spell", on); },
    on: (e: string, h: unknown) => { s.handlers.set(e, h); },
    listenerCount: (e: string) => (s.handlers.has(`listener:${e}`) ? 1 : 0),
  };
  return s;
}

const filterVerdict = (s: ReturnType<typeof fakeSession>, url: string): boolean => {
  let cancel: boolean | undefined;
  s.filters[0]!({ url }, (r) => (cancel = r.cancel));
  return cancel === false;
};

test("the window session: the scheme handler, the permission policy and the request filter", async () => {
  const s = fakeSession();
  hardenAppSession(s, { bundleRoot: "/nonexistent-axis-bundle", packaged: true });
  assert.deepEqual(s.handled, [APP_SCHEME], "H4");
  for (const k of ["request", "check", "device", "display", "will-download"]) assert.ok(s.handlers.has(k), `H4: ${k}`);
  assert.equal(s.handlers.get("spell"), false, "H4");
  assert.equal(s.filters.length, 1, "H4");
  assert.equal(filterVerdict(s, APP_URL), true);
  assert.equal(filterVerdict(s, "https://example.com/"), false, "H4");
  assert.equal(filterVerdict(s, "devtools://devtools/bundled/inspector.html"), false, "H5");
  const res = await (s.handlers.get(`scheme:${APP_SCHEME}`) as (r: Request) => Promise<Response>)(new Request(APP_URL));
  assert.equal(res.status, 404, "a missing bundle is not found");
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/, "H4: every response carries the CSP");
  const dev = fakeSession();
  hardenAppSession(dev, { bundleRoot: "/b", packaged: false });
  assert.equal(filterVerdict(dev, "devtools://devtools/bundled/inspector.html"), true, "H5: unpackaged only");
});

function fakeWindow(id: number) {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  const w = {
    loaded: [] as string[],
    contentsEvents: [] as string[],
    openHandler: undefined as unknown,
    webContents: {
      id,
      on: (e: string) => { w.contentsEvents.push(e); },
      setWindowOpenHandler: (h: unknown) => { w.openHandler = h; },
      listenerCount: (e: string) => (e === w.heard ? 1 : 0),
    },
    heard: "",
    on: (e: string, l: (...a: unknown[]) => void) => { listeners.set(e, [...(listeners.get(e) ?? []), l]); },
    loadURL: async (u: string) => { w.loaded.push(u); },
    emit: (e: string) => { for (const l of listeners.get(e) ?? []) l(); },
  };
  return w;
}

test("a window: registered, loaded at the app URL, pruned on close; its policy comes from the app-wide hook only", async () => {
  const registry = new WindowRegistry();
  const w = fakeWindow(41);
  const options: unknown[] = [];
  const opened = await openAppWindow({ create: (o) => (options.push(o), w), options: { show: false }, registry });
  assert.deepEqual(options, [{ show: false }]);
  assert.equal(registry.byWebContents(41)?.id, opened.id, "H6");
  assert.deepEqual(w.contentsEvents, [], "N2: hardened once, by installAppHardening");
  assert.deepEqual(w.loaded, [APP_URL], "H6");
  w.emit("closed");
  assert.equal(registry.has(opened.id), false, "H7");
});

test("a window the registry refuses is not loaded", async () => {
  const registry = new WindowRegistry({ maxWindows: 1 });
  await openAppWindow({ create: () => fakeWindow(1), options: {}, registry });
  const w2 = fakeWindow(2);
  await assert.rejects(openAppWindow({ create: () => w2, options: {}, registry }), /registry/);
  assert.deepEqual(w2.loaded, [], "H6");
});

test("senderOf reads the frame of the event, and a missing frame fails the checks", () => {
  const mainFrame = { url: APP_URL, parent: null };
  assert.deepEqual(senderOf({ sender: { id: 3, isDestroyed: () => false }, senderFrame: mainFrame }), { webContentsId: 3, frameUrl: APP_URL, isMainFrame: true, destroyed: false });
  const child = { url: APP_URL, parent: mainFrame };
  assert.equal(senderOf({ sender: { id: 3, isDestroyed: () => false }, senderFrame: child }).isMainFrame, false);
  assert.deepEqual(senderOf({ sender: { id: 3, isDestroyed: () => true }, senderFrame: null }), { webContentsId: 3, frameUrl: undefined, isMainFrame: false, destroyed: true });
});

test("openExternal: only an app window's main frame is answered, and only through the confirmation", async () => {
  const registry = new WindowRegistry();
  const entry = registry.add(7)!;
  const shown: string[] = [];
  const opened: string[] = [];
  const opener = createExternalOpener({ confirm: async (_id, c) => (shown.push(c.detail), true), open: async (h) => void opened.push(h), isWindow: (id) => registry.has(id) });
  let channel = "";
  let handler: ((event: Parameters<typeof senderOf>[0], ...args: unknown[]) => Promise<unknown>) | undefined;
  registerOpenExternal({ ipcMain: { handle: (c, h) => ((channel = c), (handler = h)) }, registry, opener });
  assert.equal(channel, IPC_CHANNELS.openExternal);
  const frame = { url: APP_URL, parent: null };
  const ev = (id: number, f: { url: string; parent: unknown } | null = frame) => ({ sender: { id, isDestroyed: () => false }, senderFrame: f });
  assert.deepEqual(await handler!(ev(8), { url: "https://example.com/" }), { ok: false, reason: "no_window" }, "H8: unknown window");
  assert.deepEqual(await handler!(ev(7, { url: "https://evil.example/", parent: null }), { url: "https://example.com/" }), { ok: false, reason: "no_window" }, "H8: wrong frame");
  assert.deepEqual(await handler!(ev(7), { url: "https://example.com/", extra: 1 }), { ok: false, reason: "not_string" }, "H8: payload shape");
  assert.deepEqual(shown, []);
  assert.deepEqual(await handler!(ev(7), { url: "https://example.com/a" }), { ok: true });
  assert.deepEqual(shown, ["https://example.com/a"], "H8: confirmed first");
  assert.deepEqual(opened, ["https://example.com/a"]);
  registry.close(entry.id);
  assert.deepEqual(await handler!(ev(7), { url: "https://example.com/b" }), { ok: false, reason: "no_window" }, "H8: closed");
});

test("openExternal: a sender that fails the checks never reaches the opener", async () => {
  const registry = new WindowRegistry();
  registry.add(7);
  const reached: unknown[] = [];
  const spy = { open: async (id: number, input: unknown) => (reached.push([id, input]), { ok: true as const }), windowClosed: () => {} };
  let handler: ((event: Parameters<typeof senderOf>[0], ...args: unknown[]) => Promise<unknown>) | undefined;
  registerOpenExternal({ ipcMain: { handle: (_c, h) => void (handler = h) }, registry, opener: spy });
  const frame = { url: APP_URL, parent: null };
  for (const ev of [
    { sender: { id: 8, isDestroyed: () => false }, senderFrame: frame },
    { sender: { id: 7, isDestroyed: () => false }, senderFrame: { url: "axis-app://shell/", parent: null } },
    { sender: { id: 7, isDestroyed: () => false }, senderFrame: { url: APP_URL, parent: frame } },
    { sender: { id: 7, isDestroyed: () => true }, senderFrame: frame },
    { sender: { id: 7, isDestroyed: () => false }, senderFrame: null },
  ]) {
    assert.deepEqual(await handler!(ev, { url: "https://example.com/" }), { ok: false, reason: "no_window" }, "H8");
  }
  assert.deepEqual(reached, [], "H8: the opener was never asked");
  assert.deepEqual(await handler!({ sender: { id: 7, isDestroyed: () => false }, senderFrame: frame }, { url: "https://example.com/" }), { ok: true });
  assert.equal(reached.length, 1);
});

test("fork: the fixed options, and an absolute entry only", () => {
  const forks: Array<[string, unknown[], Record<string, unknown>]> = [];
  const up = { fork: (e: string, a: unknown[], o: object) => (forks.push([e, a, o as Record<string, unknown>]), { pid: 1 }) };
  forkUtility(up, "/app/daemon.cjs", "axis-daemon", { PATH: "/bin" }, "/app", "linux");
  assert.deepEqual(forks[0]?.[1], []);
  assert.deepEqual(forks[0]?.[2]?.["execArgv"], UTILITY_EXEC_ARGV, "H9");
  assert.equal(forks[0]?.[2]?.["serviceName"], "axis-daemon");
  assert.equal(forks[0]?.[2]?.["stdio"], "pipe");
  assert.equal(forks[0]?.[2]?.["cwd"], "/app", "H9");
  assert.throws(() => forkUtility(up, "daemon.cjs", "axis-daemon", {}, "/app", "linux"), /absolute/, "H9");
  assert.throws(() => forkUtility(up, "/app/daemon.cjs", "axis-daemon", { NODE_OPTIONS: "--inspect" }, "/app", "linux"), /NODE_/, "H9: the fork options' refusals hold");
  assert.equal(forks.length, 1);
});

test("startup: a missing Electron API or a device chooser listener stops main", async () => {
  assert.throws(() => requireApis({ a: () => 1 }, ["a", "b"], "x"), /x lacks b/, "H10");
  assert.doesNotThrow(() => requireApis({ a: () => 1 }, ["a"], "x"));
  for (const missing of ["setDevicePermissionHandler", "setDisplayMediaRequestHandler", "setSpellCheckerEnabled"]) {
    const s = fakeSession() as Record<string, unknown>;
    delete s[missing];
    assert.throws(() => hardenAppSession(s as unknown as ReturnType<typeof fakeSession>, { bundleRoot: "/b", packaged: true }), new RegExp(missing), `H10: ${missing}`);
  }
  for (const e of ["select-hid-device", "select-serial-port", "select-usb-device"]) {
    const s = fakeSession();
    s.handlers.set(`listener:${e}`, 1);
    assert.throws(() => hardenAppSession(s, { bundleRoot: "/b", packaged: true }), /device chooser/, `H10: ${e}`);
  }
  const w = fakeWindow(9);
  w.heard = "select-bluetooth-device";
  await assert.rejects(openAppWindow({ create: () => w, options: {}, registry: new WindowRegistry() }), /device chooser/, "H10: bluetooth");
  assert.deepEqual(w.loaded, []);
});

test("the overlap check resolves links, also for directories not created yet", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "axis-overlap-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "data", "Axis"), { recursive: true });
  symlinkSync(join(dir, "data"), join(dir, "appdata"));
  assert.equal(resolveExisting(join(dir, "appdata", "Axis", "axis-shell"), realpathSync.native), join(dir, "data", "Axis", "axis-shell"), "H11");
  assert.equal(resolveExisting(join(dir, "nope", "x", "..", "y"), realpathSync.native), join(dir, "nope", "y"));
  const f = fakeApp(join(dir, "appdata", "Axis"));
  assert.throws(() => prepareBeforeReady({ app: f.app, protocol: f.protocol, platform: "linux", dataBase: join(dir, "data", "Axis") }), /overlap/, "H11: through a link");
});

function fakeAppEvents() {
  const handlers = new Map<string, (...a: unknown[]) => void>();
  return { handlers, app: { on: (e: string, h: (...a: unknown[]) => void) => void handlers.set(e, h) } };
}

test("app-wide: every web contents gets the policy; no client certificate, no login", () => {
  const events: string[] = [];
  const { app, handlers } = fakeAppEvents();
  installAppHardening(app as never, (e) => events.push(`${e.kind}:${"what" in e ? e.what : ""}`));
  const w = fakeWindow(5);
  handlers.get("web-contents-created")!({}, w.webContents);
  assert.deepEqual(w.contentsEvents.sort(), ["will-attach-webview", "will-frame-navigate", "will-navigate", "will-redirect"], "H12");
  assert.ok(w.openHandler, "H12");
  const chooser = fakeWindow(6);
  chooser.heard = "select-bluetooth-device";
  assert.throws(() => handlers.get("web-contents-created")!({}, chooser.webContents), /device chooser/, "H12: the default fatal throws");
  const fatals: string[] = [];
  const second = fakeAppEvents();
  installAppHardening(second.app as never, () => {}, (e) => void fatals.push(e.message));
  const late = fakeWindow(7);
  late.heard = "select-bluetooth-device";
  second.handlers.get("web-contents-created")!({}, late.webContents);
  assert.deepEqual(late.contentsEvents.sort(), ["will-attach-webview", "will-frame-navigate", "will-navigate", "will-redirect"], "H12: hardened before the check failed");
  assert.ok(late.openHandler, "H12");
  assert.equal(fatals.length, 1, "H12: a failed check stops main");
  assert.match(fatals[0]!, /device chooser/);
  let prevented = 0;
  const answers: unknown[][] = [];
  handlers.get("select-client-certificate")!({ preventDefault: () => prevented++ }, {}, "https://x", [{ cert: 1 }], (...a: unknown[]) => answers.push(a));
  handlers.get("login")!({ preventDefault: () => prevented++ }, {}, {}, {}, (...a: unknown[]) => answers.push(a));
  assert.equal(prevented, 2, "H12");
  assert.deepEqual(answers, [[], []], "H12: no certificate, no credentials");
  assert.deepEqual(events.filter((e) => e.includes("client_certificate") || e.includes("login")), ["policy:client_certificate", "policy:login"]);
});

test("EL-5 dialog: Cancel the default, no link, the confirmed URL; only Open opens exactly what was shown", async () => {
  const registry = new WindowRegistry();
  const entry = registry.add(11)!;
  const shown: Array<{ win: string; options: ReturnType<typeof externalDialogOptions> }> = [];
  const opened: string[] = [];
  let response = OPEN_BUTTON;
  const opener = createMainExternalOpener({
    registry,
    windowFor: (id) => (id === entry.id ? "win" : undefined),
    showMessageBox: async (win, options) => (shown.push({ win, options }), { response }),
    openExternal: async (href) => void opened.push(href),
  });
  assert.deepEqual(await opener.open(entry.id, "HTTPS://Example.COM/a b".replace(" ", "%20")), { ok: true });
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0], {
    win: "win",
    options: { type: "question", message: "Open this link in your browser?", detail: "https://example.com/a%20b", buttons: ["Cancel", "Open link"], defaultId: 0, cancelId: 0, noLink: true },
  }, "H13");
  assert.equal(shown[0]!.options.buttons[OPEN_BUTTON], "Open link", "H13");
  assert.deepEqual(opened, ["https://example.com/a%20b"], "H13: exactly the shown string");
  for (const r of [0, 2, -1, Number.NaN]) {
    response = r;
    assert.deepEqual(await opener.open(entry.id, "https://example.com/"), { ok: false, reason: "declined" }, `H13: response ${r}`);
  }
  assert.deepEqual(opened.length, 1, "H13: nothing else opened");
  assert.deepEqual(await opener.open(99, "https://example.com/"), { ok: false, reason: "no_window" });
});
