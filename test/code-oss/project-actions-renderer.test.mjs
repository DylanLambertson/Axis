// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// S3: the renderer's project actions. Only the IPC module talks to main, only on the two project channels; the commands take no
// arguments; the banner never focuses or defaults a button; the desktop entry replaces the unavailable service.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const AXIS = fileURLToPath(new URL("../../code-oss/overlay/src/vs/axis", import.meta.url));
const read = (rel) => readFileSync(join(AXIS, rel), "utf8");
const IPC = "services/projects/electron-browser/axisProjectActionsIpc.ts";

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith(".ts")) out.push(relative(AXIS, p).split(sep).join("/"));
  }
  return out;
}
const renderer = () => sources(AXIS).filter((f) => !f.includes("/test/") && !f.includes("/electron-main/") && !f.includes("/node/"));

test("only the IPC module uses ipcRenderer, and only through the client's two project channels", () => {
  assert.deepEqual(renderer().filter((f) => /\bipcRenderer\s*[.(]|import[^;]*\bipcRenderer\b/.test(read(f))), [IPC]);
  const ipc = read(IPC);
  assert.match(ipc, /new AxisProjectActionClient\(/);
  assert.doesNotMatch(ipc, /['"`]vscode:/, "no channel literal of its own: the client fixes them");
  assert.equal((ipc.match(/ipcRenderer\.send\(/g) ?? []).length, 1);
  assert.doesNotMatch(ipc, /ipcRenderer\.(invoke|sendSync|postMessage|sendTo)\b/);
  const literal = renderer().filter((f) => /vscode:axisProjectAction/.test(read(f)));
  assert.deepEqual(literal, ["services/projects/common/axisProjectActions.ts"]);
});

test("the project commands take no arguments, and the banner never focuses or defaults its button", () => {
  const commands = read("contrib/projects/browser/axisProjects.contribution.ts");
  const runs = [...commands.matchAll(/^\trun\(([^)]*)\)/gm)].map((m) => m[1]); // the Action2 methods
  assert.equal(runs.length, 3);
  for (const params of runs) assert.equal(params, "accessor: ServicesAccessor", "no argument can aim an action");
  const banner = read("contrib/projects/browser/axisProjectBanner.ts");
  assert.doesNotMatch(banner, /\.focus\(|autofocus|\.click\(\)/);
  assert.match(banner, /\.type = 'button'/);
});

test("the desktop entry registers the IPC service after the shared entry; the shared entry has only the unavailable one", () => {
  const desktop = read("axis.desktop.main.ts");
  const common = read("axis.common.main.ts");
  assert.ok(desktop.indexOf("import './services/projects/electron-browser/axisProjectActionsIpc.js';") > desktop.indexOf("import './axis.common.main.js';"));
  assert.ok(common.includes("import './services/projects/browser/axisUnavailableProjectActions.js';"));
  assert.doesNotMatch(common, /axisProjectActionsIpc/);
});
