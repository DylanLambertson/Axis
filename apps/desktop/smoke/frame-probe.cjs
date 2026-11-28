// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Mounted frame checks (OS-6 review SF1, SF2, SF4), run by frame.test.mjs as Electron's main script. It loads the
// bundled renderer page (apps/desktop/dist/app/renderer/index.html: the product's own page and CSP, no preload, no
// test hook in the product) in a sandboxed window, drives it with real input events and DOM-dispatched key events,
// and prints one line `AXIS_FRAME_PROBE <json>` of what it saw, then quits. The test decides pass or fail.

const { app, BrowserWindow, nativeTheme } = require("electron");
const path = require("node:path");

const MARKER = "AXIS_FRAME_PROBE ";
const appDir = process.argv[process.argv.length - 1];
const page = path.join(appDir, "renderer", "index.html");
const settle = () => new Promise((r) => setTimeout(r, 120));

async function open(win, hash) {
  await win.loadURL("about:blank"); // a fresh page each time: a hash change alone would keep the old DOM
  await win.loadFile(page, { hash });
  for (let i = 0; i < 50; i++) {
    if (await win.webContents.executeJavaScript(`document.documentElement.dataset.axisShell === "mounted"`)) return;
    await settle();
  }
  throw new Error(`the frame did not mount at ${hash}`);
}

function driver(win) {
  const js = (source) => win.webContents.executeJavaScript(source);
  const press = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    if (modifiers.length === 0 && (keyCode.length === 1 || keyCode === "Enter")) win.webContents.sendInputEvent({ type: "char", keyCode: keyCode === "Enter" ? "\r" : keyCode });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await settle();
  };
  /** A keydown dispatched on the focused element, for what real input cannot make here (IME composition, repeat). */
  const dispatch = async (init) => {
    await js(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", Object.assign({ bubbles: true, cancelable: true }, ${JSON.stringify(init)})))`);
    await settle();
  };
  const state = () =>
    js(`({
      hash: location.hash,
      dialog: document.querySelector('[role="dialog"]') !== null,
      focus: document.activeElement === null ? "" : (document.activeElement.getAttribute("role") || document.activeElement.tagName.toLowerCase()) + (document.activeElement.textContent && document.activeElement.closest(".axis-rail") ? ":" + document.activeElement.textContent.replace(/^\\W+/, "") : ""),
      empty: document.querySelector(".axis-palette__empty") !== null,
      stops: [...document.querySelectorAll(".axis-rail__item")].map((b) => b.tabIndex),
    })`);
  return { js, press, dispatch, state };
}

async function palette(win) {
  const d = driver(win);
  const out = {};
  await open(win, "/home");
  await d.js(`document.querySelector('.axis-rail__item[aria-current="page"]').focus()`);
  await d.press("K", ["control"]);
  out.opened = await d.state();
  await d.dispatch({ key: "Enter", isComposing: true });
  out.composingEnter = await d.state();
  await d.dispatch({ key: "Process", keyCode: 229 });
  out.processKey = await d.state();
  await d.dispatch({ key: "Escape", isComposing: true });
  out.composingEscape = await d.state();
  await d.dispatch({ key: "Enter", repeat: true });
  out.repeatedEnter = await d.state();
  await d.dispatch({ key: "Enter", ctrlKey: true });
  out.ctrlEnter = await d.state();
  for (const c of "zzzq") await d.press(c);
  await d.press("Enter");
  out.emptyEnter = await d.state();
  for (let i = 0; i < 4; i++) await d.press("Backspace");
  await d.press("Enter");
  out.plainEnter = await d.state();
  return out;
}

async function rail(win) {
  const d = driver(win);
  const out = {};
  await open(win, "/home");
  await d.js(`document.querySelector('.axis-rail__item[aria-current="page"]').focus()`);
  await d.press("Down");
  out.roved = await d.state();
  await d.js(`location.hash = "#/tasks"`);
  await settle();
  out.afterHash = await d.state();
  await d.js(`document.querySelector('.axis-rail__item[tabindex="0"]').focus()`);
  await d.press("Up");
  out.arrowAfterHash = await d.state();
  await d.press("K", ["control"]);
  for (const c of "home") await d.press(c);
  await d.press("Enter");
  out.afterPalette = await d.state();
  await d.js(`document.querySelector('.axis-rail__item[aria-current="page"]').focus()`);
  await d.press("End");
  await d.js(`location.hash = "#/workspaces"`);
  await settle();
  await d.js(`location.hash = "#/home"`);
  await settle();
  out.backToRoved = await d.state();
  return out;
}

/** Page width at 320 CSS px (1280 device px at 400% zoom), with long unbroken names put into the frame's text. */
async function reflow(win, theme) {
  const d = driver(win);
  nativeTheme.themeSource = theme;
  const measure = () =>
    d.js(`(() => {
      const main = document.querySelector(".axis-main");
      const right = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().right) : -1; };
      return { width: innerWidth, page: document.documentElement.scrollWidth, main: main.scrollWidth - main.clientWidth, commands: right(".axis-top__cmd"), activity: right(".axis-top__activity"), tag: right(".axis-top .axis-tag") };
    })()`);
  const out = {};
  await open(win, "/home");
  win.webContents.setZoomFactor(4);
  await settle();
  out.home = await measure();
  // A long project name in the breadcrumb and the read-only tag (shown when secure storage is missing).
  await d.js(`(() => {
    document.querySelector(".axis-top__crumb [aria-current]").textContent = "p".repeat(300);
    const tag = document.createElement("span");
    tag.className = "axis-tag axis-tag--warn";
    tag.textContent = "Read only";
    document.querySelector(".axis-top__activity").before(tag);
  })()`);
  await settle();
  out.longNameReadOnly = await measure();
  await open(win, "/states");
  win.webContents.setZoomFactor(4);
  await d.js(`(() => {
    const card = document.querySelector(".axis-decision");
    card.querySelector("h3").textContent = "t".repeat(400);
    card.querySelector("dd").textContent = "v".repeat(2000);
    document.querySelector(".axis-notice p").append("n".repeat(1000));
    document.querySelector(".axis-review__path").textContent = "src/" + "d".repeat(500) + ".ts";
  })()`);
  await settle();
  out.gallery = await measure();
  win.webContents.setZoomFactor(1);
  return out;
}

app.whenReady().then(async () => {
  const result = {};
  try {
    const win = new BrowserWindow({ width: 1280, height: 2800, useContentSize: true, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    win.focus();
    result.palette = await palette(win);
    result.rail = await rail(win);
    result.reflowDark = await reflow(win, "dark");
    result.reflowLight = await reflow(win, "light");
  } catch (e) {
    result.error = String(e && e.stack ? e.stack : e);
  }
  process.stdout.write(`${MARKER}${JSON.stringify(result)}\n`);
  app.exit(0);
});
