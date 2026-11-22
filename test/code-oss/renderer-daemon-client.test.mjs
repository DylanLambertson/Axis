// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-E0: the renderer's daemon client. Only main's attested `vscode:axisConnect` port leads to the daemon, only the client module
// opens it, and only the desktop entry registers it (web and browser builds keep the unavailable client).
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const AXIS = fileURLToPath(new URL("../../code-oss/overlay/src/vs/axis", import.meta.url));
const read = (rel) => readFileSync(join(AXIS, rel), "utf8");

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith(".ts")) out.push(relative(AXIS, p).split(sep).join("/"));
  }
  return out;
}

test("only the client module imports connectAxisDaemon, and the connection asks main only on vscode:axisConnect", () => {
  const importers = sources(AXIS).filter((f) => !f.includes("/test/") && /\bconnectAxisDaemon\b/.test(read(f)) && /from '[^']*axisDaemonConnection\.js'/.test(read(f)));
  assert.deepEqual(importers, ["services/daemon/electron-browser/axisRendererDaemonClient.ts"]);
  const connection = read("services/daemon/electron-browser/axisDaemonConnection.ts");
  const channels = [...connection.matchAll(/acquirePort\(\s*'([^']+)'\s*,\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(channels, [["vscode:axisConnect", "vscode:axisConnectResult"]], "the only port request is main's attested connect");
  assert.equal((connection.match(/acquirePort\(/g) ?? []).length, 1);
  // No other renderer module asks main for a port at all.
  const others = sources(AXIS).filter((f) => !f.includes("/test/") && f !== "services/daemon/electron-browser/axisDaemonConnection.ts" && /\bacquirePort\(/.test(read(f)));
  assert.deepEqual(others, []);
});

test("the desktop entry registers the real client after the shared entry; the shared (web) entry never loads it", () => {
  const desktop = read("axis.desktop.main.ts");
  const common = read("axis.common.main.ts");
  const at = (s, needle) => s.indexOf(needle);
  assert.ok(at(desktop, "import './axis.common.main.js';") >= 0);
  assert.ok(at(desktop, "import './services/daemon/electron-browser/axisRendererDaemonClient.js';") > at(desktop, "import './axis.common.main.js';"), "registered after, so it replaces the unavailable client");
  assert.ok(common.includes("import './services/daemon/browser/axisUnavailableDaemonClient.js';"));
  assert.doesNotMatch(common, /axisRendererDaemonClient|electron-browser/);
  const client = read("services/daemon/electron-browser/axisRendererDaemonClient.ts");
  assert.match(client, /registerSingleton\(IAxisDaemonClient, AxisRendererDaemonClient, InstantiationType\.Delayed\)/);
  assert.match(client, /connectAxisDaemon\(AXIS_SHELL_CONTRACTS, onClose, AXIS_WELCOME_TIMEOUT_MS\)/, "the fixed contract list and the welcome bound");
});
