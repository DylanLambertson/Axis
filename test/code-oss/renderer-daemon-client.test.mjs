// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-E0: the renderer's daemon client. Only main's attested `vscode:axisConnect` port leads to the daemon, only the client module
// opens it, and only the desktop entry registers it (web and browser builds keep the unavailable client).
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ALLOWED, CORE, scanDaemonCalls } from "./daemon-call-rule.mjs";

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

// PV-E0 F2 condition (e) and review SF1: the shell's contract list is the only capability change. Every renderer-side file is
// parsed; `request` may only be called directly with an allowed literal pair (test/code-oss/daemon-call-rule.mjs).
test("every daemon call in the renderer is a literal allowed pair; axis.audit only through the core's .call; one pinned pass-through", () => {
  const files = sources(AXIS).filter((f) => !f.includes("/test/") && !f.includes("/electron-main/") && !f.includes("/node/"));
  const all = { violations: [], pairs: new Set(), passThroughs: [] };
  for (const f of files) {
    const r = scanDaemonCalls(f, read(f));
    all.violations.push(...r.violations);
    r.pairs.forEach((p) => all.pairs.add(p));
    all.passThroughs.push(...r.passThroughs.map((x) => `${f}: ${x}`));
  }
  assert.deepEqual(all.violations, []);
  assert.deepEqual([...all.pairs].sort(), [...ALLOWED], "every allowed pair is in use; a new one needs a review and the list");
  assert.deepEqual(all.passThroughs, [`${CORE}: contract, method, params`], "the core's request() pass-through, and nothing else");
  const client = read("services/daemon/common/axisDaemonClient.ts");
  assert.match(client, /export type AxisReadContract = 'axis\.projects' \| 'axis\.worktrees' \| 'axis\.cli-runs' \| 'axis\.approvals';/, "request() cannot name axis.audit");
});

test("the scanner refuses every evasion (self-test): concatenation, variables, aliases, optional and bracket calls, destructuring, audit outside the core", () => {
  const probes = {
    concat: "c.request('axis.' + 'git', 'commit', {});",
    variableContract: "c.request(contract, 'list', {});",
    aliasedMethod: "const r = c.request; r('axis.git', 'commit', {});",
    boundMethod: "const r = c.request.bind(c);",
    optionalCall: "c?.request?.('axis.git', 'commit', {});",
    bracket: "c['request']('axis.projects', 'list', {});",
    variableMethod: "c.request('axis.projects', method, {});",
    auditViaRequest: "c.request('axis.audit', 'status', {});",
    auditVariable: "c.request(aud, 'status', {});",
    auditCallOutsideCore: "c.call('axis.audit', 'status', {});",
    gitCall: "c.call('axis.git', 'commit', {});",
    destructure: "const { request } = c;",
    destructureRenamed: "const { request: go } = c;",
    template: "c.request(`axis.${x}`, 'list', {});",
  };
  for (const [name, code] of Object.entries(probes)) {
    assert.ok(scanDaemonCalls("contrib/x/browser/probe.ts", code).violations.length > 0, `${name} must be refused: ${code}`);
  }
  for (const ok of ["this.client.request('axis.projects', 'list', {}, t);", "fn.call(thisArg, 1);", "c?.request('axis.worktrees', 'status', { ids });"]) {
    assert.deepEqual(scanDaemonCalls("contrib/x/browser/ok.ts", ok).violations, [], ok);
  }
  assert.deepEqual(scanDaemonCalls(CORE, "client.call('axis.audit', 'status', {});").violations, [], "the core may read audit status");
});
