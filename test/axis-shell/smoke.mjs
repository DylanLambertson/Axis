// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Keyboard smoke test of the Axis Agent view shell (ADR 0004 Phase 0 gate
// items 1 and 3; docs/UX.md view switching and focus rules). It attaches to a
// running Axis development build started with --remote-debugging-port on the
// demo repository of scripts/code-oss/shell-demo-fixture.sh. Every action is
// a key event (Input.dispatchKeyEvent) or typed text (Input.insertText, in the
// editor and the command palette); the page is only read, never clicked or
// focused by script. The one exception is the split mode setting, which the
// test writes to the user settings file, as a user editing it would. It
// asserts what renders and where focus goes and saves a screenshot per step.
//
// Usage: node test/axis-shell/smoke.mjs --port <n> --out <dir> --settings <user settings.json> [--app-path <tree>]
// With --app-path (the Code OSS tree the app runs from), the Node utility
// processes of that app (the extension host among them) must be the same
// before and after twenty toggles: no restart (design task A1).
// The launch recipe is in docs/design/axis-shell-runbook.md.

import { strict as assert } from "node:assert";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { connect } from "./cdp.mjs";

const { values: args } = parseArgs({
  options: { port: { type: "string" }, out: { type: "string" }, settings: { type: "string" }, "app-path": { type: "string" } },
});
if (!args.port || !args.out || !args.settings) {
  console.error("usage: smoke.mjs --port <n> --out <dir> --settings <user settings.json>");
  process.exit(2);
}

/**
 * The DevTools port must listen on loopback only. Chromium binds 127.0.0.1 for
 * --remote-debugging-port, and Electron ignores --remote-debugging-address, so
 * this is checked rather than requested. Linux only (/proc/net); elsewhere it is skipped.
 */
async function assertLoopbackOnly(port) {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  const loopback = new Set(["0100007F", "00000000000000000000000001000000"]);
  let found = 0;
  let tables = 0;
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = await readFile(table, "utf8").catch(() => undefined);
    if (text === undefined) {
      continue;
    }
    tables++;
    for (const line of text.split("\n").slice(1)) {
      const [, local, , state] = line.trim().split(/\s+/);
      if (state === "0A" && local?.endsWith(`:${hexPort}`)) {
        found++;
        assert.ok(loopback.has(local.split(":")[0]), `the DevTools port listens beyond loopback: ${local}`);
      }
    }
  }
  if (!tables) {
    console.log(`     DevTools port binding not checked: no /proc/net on this system`);
    return;
  }
  // Seen through CDP but not in this network namespace's tables: the binding cannot be confirmed, so fail.
  assert.ok(found > 0, `no listener on port ${port} in /proc/net; the app may run in another network namespace, so its binding is unchecked`);
  console.log(`     DevTools port ${port} listens on loopback only`);
}
const AXIS = ["Control", "Shift", "Alt"]; // Windows and Linux defaults (docs/UX.md); macOS differs
const out = args.out;
await mkdir(out, { recursive: true });
const cdp = await connect(Number(args.port));
await assertLoopbackOnly(Number(args.port));
const results = [];
let shot = 0;

async function step(name, body) {
  const started = Date.now();
  try {
    await body();
    const file = await cdp.screenshot(out, `${String(++shot).padStart(2, "0")}-${name}`);
    results.push({ name, ok: true, ms: Date.now() - started, file });
    console.log(`ok   ${name}`);
  } catch (error) {
    await cdp.screenshot(out, `${String(++shot).padStart(2, "0")}-${name}-FAILED`).catch(() => {});
    results.push({ name, ok: false, error: String(error?.message ?? error) });
    console.log(`FAIL ${name}: ${error?.message ?? error}`);
    throw error;
  }
}

/** Page-side read-only helpers; installed now and on every new document, so a reload during startup does not lose them. */
const HELPERS = `(() => {
  const shown = el => !!el && el.getClientRects().length > 0 && el.getBoundingClientRect().width > 2;
  window.__axis = {
    shown,
    agent: () => document.getElementById('axis.parts.agent'),
    agentShown: () => shown(document.getElementById('axis.parts.agent')),
    agentCollapsed: () => !!document.querySelector('#axis\\\\.parts\\\\.agent .axis-agent-root.collapsed'),
    editorShown: () => shown(document.getElementById('workbench.parts.editor')),
    focusInAgent: () => !!document.getElementById('axis.parts.agent')?.contains(document.activeElement),
    focusInEditor: () => !!document.getElementById('workbench.parts.editor')?.contains(document.activeElement),
    focusOnBody: () => document.activeElement === document.body,
    activeLabel: () => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '',
    rows: () => [...document.querySelectorAll('.axis-dashboard-row')].map(r => r.getAttribute('aria-label')),
    title: () => document.querySelector('.axis-workspace-title')?.textContent,
    treeRows: () => [...document.querySelectorAll('.axis-file-tree-row')].map(r => r.textContent),
    activeTab: () => document.querySelector('.tabs-container .tab.active')?.getAttribute('aria-label') ?? '',
    activeTabDirty: () => !!document.querySelector('.tabs-container .tab.active.dirty'),
    announced: () => [...document.querySelectorAll('.monaco-aria-container .monaco-status')].map(e => e.textContent).join(' | '),
    terminals: () => document.querySelectorAll('.terminal-wrapper').length,
    rect: id => { const r = document.getElementById(id)?.getBoundingClientRect(); return r && { x: Math.round(r.x), w: Math.round(r.width) }; },
  };
  return true;
})()`;
await cdp.send("Page.enable");
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HELPERS });
await cdp.eval(HELPERS);
const page = (expr) => cdp.eval(`window.__axis.${expr}`);

/** Pids of the app's Node utility processes (the extension host is one), or undefined without --app-path. */
function nodeServicePids() {
  if (!args["app-path"]) {
    return undefined;
  }
  const lines = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" }).split("\n");
  return lines
    .filter((l) => l.includes(args["app-path"]) && l.includes("node.mojom.NodeService"))
    .map((l) => l.trim().split(/\s+/)[0])
    .sort()
    .join(",");
}

/** Sets axis.view.mode in the user settings file. The test profile's file is plain JSON (no comments); anything else is refused. */
async function setMode(mode) {
  const text = await readFile(args.settings, "utf8").catch(() => "{}");
  let current;
  try {
    current = JSON.parse(text);
  } catch {
    throw new Error(`${args.settings} is not plain JSON; use a fresh test profile`);
  }
  current["axis.view.mode"] = mode;
  await writeFile(args.settings, JSON.stringify(current, null, "\t"));
}

/** Runs a command through the command palette, by keys and typed text. */
async function runCommand(title) {
  await cdp.press("p", ["Control", "Shift"]);
  await cdp.waitFor("!!document.querySelector('.quick-input-widget input:focus')", { what: "the command palette" });
  await cdp.type(title);
  await cdp.waitFor(`[...document.querySelectorAll('.quick-input-list .monaco-list-row.focused')].some(r => r.textContent.includes(${JSON.stringify(title)}))`, { what: `palette entry ${title}` });
  await cdp.press("Enter");
}

try {
  await step("dashboard", async () => {
    await cdp.waitFor("window.__axis.rows().length >= 4", { what: "four dashboard rows", timeoutMs: 60_000 });
    assert.ok(await page("agentShown()"), "the agent part shows at startup");
    assert.ok(!(await page("editorShown()")), "the editor is hidden in the Agent view");
    const rows = await page("rows()");
    for (const name of ["demo-repo", "fix-login", "add-search", "spike"]) {
      assert.ok(rows.some((r) => r.startsWith(name)), `row ${name} in ${JSON.stringify(rows)}`);
    }
    assert.ok(rows.some((r) => r.includes("local checkout")), "the local checkout row is labelled");
    assert.ok(rows.some((r) => r.includes("detached at")), "the detached worktree shows its commit");
    assert.ok(!(await page("focusOnBody()")), "focus is not on the body after startup");
  });

  await step("keyboard-open-workspace", async () => {
    assert.ok(await page("focusInAgent()"), "startup focus is on the dashboard");
    await cdp.press("Home");
    // Down to fix-login: find its index in the dashboard order.
    const rows = await page("rows()");
    const index = rows.findIndex((r) => r.startsWith("fix-login"));
    for (let i = 0; i < index; i++) {
      await cdp.press("ArrowDown");
    }
    assert.match(await page("activeLabel()"), /^fix-login/);
    await cdp.press("Enter");
    await cdp.waitFor("window.__axis.title() === 'fix-login'", { what: "workspace view of fix-login" });
    await cdp.waitFor("window.__axis.treeRows().length >= 3", { what: "file tree rows" });
    await cdp.waitFor("window.__axis.terminals() >= 1", { what: "a terminal bound to the worktree" });
    assert.ok(await page("focusInAgent()"), "focus moved into the workspace view");
  });

  await step("file-opens-ide-view", async () => {
    await cdp.waitFor("document.activeElement?.getAttribute('role') === 'treeitem'", { what: "focus in the file tree" });
    await cdp.press("Home");
    assert.match(await page("activeLabel()"), /^src, folder/);
    await cdp.press("ArrowRight"); // expand src
    await cdp.waitFor("window.__axis.treeRows().includes('login.ts')", { what: "src expanded" });
    await cdp.press("ArrowDown");
    assert.equal(await page("activeLabel()"), "login.ts");
    await cdp.press("Enter");
    await cdp.waitFor("window.__axis.editorShown() && !window.__axis.agentShown()", { what: "the IDE view" });
    await cdp.waitFor("window.__axis.activeTab().includes('login.ts')", { what: "login.ts open" });
    await cdp.waitFor("window.__axis.focusInEditor()", { what: "focus in the editor (focus rule 1)" });
  });

  await step("edit-then-back-to-agent", async () => {
    await cdp.type("// edited in the IDE view\n");
    await cdp.waitFor("window.__axis.activeTabDirty()", { what: "a dirty editor" });
    await cdp.press("v", AXIS);
    await cdp.waitFor("window.__axis.agentShown() && !window.__axis.editorShown()", { what: "the Agent view" });
    assert.equal(await page("title()"), "fix-login", "the workspace view is kept");
    assert.equal(await page("activeLabel()"), "login.ts", "focus returns to the file that was opened (focus rule 2)");
    assert.match(await page("announced()"), /Agent view, workspace fix-login/);
  });

  await step("back-to-ide-keeps-editor", async () => {
    await cdp.press("v", AXIS);
    await cdp.waitFor("window.__axis.editorShown() && window.__axis.focusInEditor()", { what: "IDE view with focus in the editor" });
    assert.ok(await page("activeTab().includes('login.ts')"));
    assert.ok(await page("activeTabDirty()"), "the unsaved change survived two switches");
    assert.match(await page("announced()"), /IDE view, workspace fix-login/);
  });

  await step("twenty-toggles-keep-parts", async () => {
    await cdp.eval("window.__axisAgentBefore = window.__axis.agent(), true");
    const pidsBefore = nodeServicePids();
    for (let i = 0; i < 20; i++) {
      await cdp.press("v", AXIS);
    }
    assert.ok(await cdp.eval("window.__axis.agent() === window.__axisAgentBefore"), "the agent part was never recreated");
    if (pidsBefore !== undefined) {
      assert.ok(pidsBefore.length > 0, "found the Node utility processes");
      assert.equal(nodeServicePids(), pidsBefore, "no Node utility process (extension host) restarted");
      console.log(`     node utility processes unchanged: ${pidsBefore}`);
    }
    assert.ok(await page("editorShown()"), "an even number of toggles ends in the IDE view");
    assert.ok(!(await page("focusOnBody()")));
  });

  await step("dashboard-shortcut-and-workspace-2", async () => {
    await cdp.press("0", AXIS);
    await cdp.waitFor("window.__axis.agentShown() && window.__axis.rows().length >= 4", { what: "the dashboard" });
    assert.ok(await page("focusInAgent()"), "focus on the dashboard");
    await cdp.press("2", AXIS);
    await cdp.waitFor("!!window.__axis.title()", { what: "workspace 2 focused" });
  });

  await step("split-mode", async () => {
    await setMode("split");
    await cdp.waitFor("window.__axis.agentShown() && window.__axis.editorShown()", { what: "both halves" });
    const editor = await page("rect('workbench.parts.editor')");
    const agent = await page("rect('axis.parts.agent')");
    assert.ok(agent.x >= editor.x + editor.w - 2, `agent half right of the IDE half: ${JSON.stringify({ editor, agent })}`);
    assert.ok(await cdp.eval("window.__axis.agent().querySelector('.axis-split-title') !== null"), "the agent half has its split header");
  });

  await step("split-toggle-moves-focus", async () => {
    await cdp.press("v", AXIS);
    const first = await page("focusInAgent()");
    await cdp.press("v", AXIS);
    const second = await page("focusInAgent()");
    assert.notEqual(first, second, "the toggle moves focus to the other half");
    assert.ok(await cdp.eval("window.__axis.agentShown() && window.__axis.editorShown()"), "the toggle never hides a half in split mode");
  });

  await step("split-collapse-ide-and-file-click", async () => {
    await runCommand("Collapse or Expand the IDE Pane");
    await cdp.waitFor("window.__axis.agentShown() && !window.__axis.editorShown()", { what: "IDE half collapsed" });
    await cdp.waitFor("window.__axis.treeRows().length > 0", { what: "the file tree" });
    await cdp.waitFor("window.__axis.focusInAgent()", { what: "focus in the agent half" });
    // The tree is the workspace view's primary region; walk it with the arrow keys to README.md.
    await cdp.press("Home");
    for (let i = 0; i < 20 && (await page("activeLabel()")) !== "README.md"; i++) {
      await cdp.press("ArrowDown");
    }
    assert.equal(await page("activeLabel()"), "README.md", "README.md reached by keys");
    await cdp.press("Enter");
    await cdp.waitFor("window.__axis.editorShown() && window.__axis.agentShown()", { what: "the IDE half expanded, no view switch" });
    await cdp.waitFor("window.__axis.activeTab().includes('README.md')", { what: "README.md open in the IDE half" });
  });

  await step("split-collapse-agent-f6", async () => {
    await runCommand("Collapse or Expand the Agent Pane");
    await cdp.waitFor("window.__axis.agentCollapsed()", { what: "agent half collapsed" });
    const agent = await page("rect('axis.parts.agent')");
    assert.ok(agent.w <= 40, `collapsed strip is thin: ${agent.w}`);
    let reached = false;
    for (let i = 0; i < 8 && !reached; i++) {
      await cdp.press("F6");
      reached = await page("focusInAgent()");
    }
    assert.ok(reached, "F6 reaches the collapsed agent half");
    await cdp.press("Enter"); // its header button expands it
    await cdp.waitFor("!window.__axis.agentCollapsed()", { what: "agent half expanded" });
  });

  await step("back-to-per-workspace", async () => {
    await setMode("perWorkspace");
    await cdp.waitFor("window.__axis.agentShown() !== window.__axis.editorShown()", { what: "one view" });
  });
} finally {
  await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2));
  cdp.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed} of ${results.length} steps passed; screenshots in ${out}`);
process.exitCode = failed ? 1 : 0;
