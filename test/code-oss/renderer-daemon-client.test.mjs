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

// Any static, side-effect, re-export or dynamic load of the connection module, in any quote style and across lines.
const LOADS_CONNECTION = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"`][^'"`]*axisDaemonConnection(?:\.js)?['"`]/;

test("the load pattern sees every import shape", () => {
  for (const src of [
    "import { connectAxisDaemon } from '../electron-browser/axisDaemonConnection.js';",
    'import {\n  connectAxisDaemon,\n} from "./axisDaemonConnection.js";',
    "import './axisDaemonConnection.js';",
    "export * from `./axisDaemonConnection.js`;",
    "const m = await import(\n  './axisDaemonConnection.js');",
    "const m = require('./axisDaemonConnection');",
  ]) assert.match(src, LOADS_CONNECTION, src);
  assert.doesNotMatch("import { x } from './axisDaemonClient.js';", LOADS_CONNECTION);
});

test("only the client module loads the connection, and the connection asks main only on vscode:axisConnect", () => {
  const importers = sources(AXIS).filter((f) => !f.includes("/test/") && f !== "services/daemon/electron-browser/axisDaemonConnection.ts" && LOADS_CONNECTION.test(read(f)));
  assert.deepEqual(importers, ["services/daemon/electron-browser/axisRendererDaemonClient.ts"]);
  const connection = read("services/daemon/electron-browser/axisDaemonConnection.ts");
  const channels = [...connection.matchAll(/acquirePort\(\s*['"`]([^'"`]+)['"`]\s*,\s*['"`]([^'"`]+)['"`]/g)].map((m) => [m[1], m[2]]);
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

// PV-E0 F2 condition (e): the shell's contract list is the only capability change. Every (contract, method) the renderer sends is a
// literal from this allow-list; `axis.approvals resolve` is the user's own approval decision (pre-existing, approval cards), the only
// write; `axis.audit` is read for `status` only, by the reconnect core only.
const ALLOWED = [
  "axis.approvals pending",
  "axis.approvals resolve",
  "axis.audit status",
  "axis.cli-runs list",
  "axis.projects list",
  "axis.worktrees list",
  "axis.worktrees status",
];

test("every daemon call is a literal (contract, method) from the allow-list; axis.audit only for status, only in the core", () => {
  const files = sources(AXIS).filter((f) => !f.includes("/test/") && !f.includes("/electron-main/"));
  const pairs = new Set();
  const audit = [];
  for (const f of files) {
    const text = read(f);
    for (const m of text.matchAll(/\.(?:request|call)\(\s*(['"`])(axis\.[a-z-]+)\1\s*,\s*(['"`])([A-Za-z]+)\3/g)) {
      pairs.add(`${m[2]} ${m[4]}`);
      if (m[2] === "axis.audit") audit.push(`${f}:${m[4]}`);
    }
  }
  assert.deepEqual([...pairs].sort(), ALLOWED, "a new method or contract needs a review and this list");
  assert.deepEqual(audit, ["services/daemon/common/axisDaemonReconnect.ts:status"]);
  // The only non-literal call: the core's request() pass-through, which takes a typed AxisReadContract from workbench code (no audit).
  const dynamic = files.flatMap((f) => [...read(f).matchAll(/\.(?:request|call)\(\s*(?!['"`])([A-Za-z_.]+)\s*,/g)].map((m) => `${f}:${m[1]}`))
    .filter((s) => !/\.(?:request|call)\(\s*(?:accessor|ServicesAccessor)/.test(s));
  assert.deepEqual(dynamic.filter((s) => s.includes("axisDaemon")), ["services/daemon/common/axisDaemonReconnect.ts:contract"]);
  const client = read("services/daemon/common/axisDaemonClient.ts");
  assert.match(client, /export type AxisReadContract = 'axis\.projects' \| 'axis\.worktrees' \| 'axis\.cli-runs' \| 'axis\.approvals';/, "request() cannot name axis.audit");
});
