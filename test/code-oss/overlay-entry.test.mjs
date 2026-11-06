// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The overlay entry of the daemon utility process must stay a hand-over: it imports only the entry logic and passes the process
// objects, never `ports` (the pty process and the pty git runner do not exist yet, so the host must refuse
// to start), a storage, a clock or an init timeout. A fake passed from here would run in production with no other test failing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript6";

const FILE = new URL("../../code-oss/overlay/src/vs/axis/daemon/node/axisDaemonMain.ts", import.meta.url);
const ALLOWED_ARGUMENTS = ["parentPort", "process", "env", "cwd", "platform", "execArgv", "stderr"];

/** The module specifiers and the property names of the argument of `runDaemonEntry(...)`. */
export function inspectOverlayEntry(source) {
  const sf = ts.createSourceFile("axisDaemonMain.ts", source, ts.ScriptTarget.Latest, true);
  const imports = [];
  const calls = [];
  const bad = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) imports.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) bad.push("dynamic import");
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") bad.push("require");
      if (ts.isIdentifier(node.expression) && node.expression.text === "runDaemonEntry") {
        const arg = node.arguments[0];
        if (arg === undefined || !ts.isObjectLiteralExpression(arg)) bad.push("runDaemonEntry argument is not an object literal");
        else {
          for (const p of arg.properties) {
            if (ts.isSpreadAssignment(p)) bad.push("spread in the runDaemonEntry argument");
            else calls.push(p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : "<computed>");
          }
        }
        calls.push("<call>");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { imports, args: calls.filter((c) => c !== "<call>"), calls: calls.filter((c) => c === "<call>").length, bad };
}

test("the overlay daemon entry imports only the entry logic and calls it once with the process objects and no ports", () => {
  const r = inspectOverlayEntry(readFileSync(FILE, "utf8"));
  assert.deepEqual(r.imports, ["../../packages/daemon-host/entry.js"]);
  assert.equal(r.calls, 1);
  assert.deepEqual(r.bad, []);
  assert.deepEqual([...r.args].sort(), [...ALLOWED_ARGUMENTS].sort());
  assert.equal(r.args.includes("ports"), false);
});

test("the inspection refuses an inline fake port, another import, a spread and a dynamic load", () => {
  const base = "import { runDaemonEntry } from '../../packages/daemon-host/entry.js';\n";
  const arg = (body) => `${base}runDaemonEntry({ parentPort: p, ${body} });\n`;
  assert.equal(inspectOverlayEntry(arg("ports: { snapshotter: s }")).args.includes("ports"), true);
  assert.equal(inspectOverlayEntry(arg("storage: s")).args.includes("storage"), true);
  assert.deepEqual(inspectOverlayEntry(`import { spawn } from 'node:child_process';\n${base}`).imports, ["node:child_process", "../../packages/daemon-host/entry.js"]);
  assert.deepEqual(inspectOverlayEntry(arg("...more")).bad, ["spread in the runDaemonEntry argument"]);
  assert.deepEqual(inspectOverlayEntry(`${base}const m = import('x'); runDaemonEntry({});\n`).bad, ["dynamic import"]);
  assert.deepEqual(inspectOverlayEntry(`${base}runDaemonEntry(cfg);\n`).bad, ["runDaemonEntry argument is not an object literal"]);
});

const SEAM = new URL("../../code-oss/overlay/src/vs/axis/code/electron-main/axisMainSeam.ts", import.meta.url);

test("the main seam spawns only when shouldStartDaemon allows it, takes its data roots from axisDataRoots and uses no userData path", () => {
  const src = readFileSync(SEAM, "utf8");
  const guard = src.indexOf("shouldStartDaemon(app.isPackaged)");
  const fork = src.indexOf("utilityProcess.fork");
  assert.ok(guard > 0 && fork > guard, "the packaged-build guard comes before the fork");
  assert.match(src.slice(guard, fork), /return undefined/);
  assert.match(src, /axisDataRoots\(platform, process\.env, homedir\(\)\)/);
  assert.equal(/userData/.test(src.replace(/NOT Electron's userData[^\n]*/g, "")), false, "no userData path");
  assert.match(src, /execArgv: \[\]/);
  assert.match(src, /env: daemonEnvironment\(process\.env\)/);
});

const PTY_FILE = new URL("../../code-oss/overlay/src/vs/axis/pty/node/axisPtyMain.ts", import.meta.url);

test("the overlay pty entry imports only node-pty and the entry logic, calls it once, and spawns through node-pty directly", () => {
  const src = readFileSync(PTY_FILE, "utf8");
  const sf = ts.createSourceFile("axisPtyMain.ts", src, ts.ScriptTarget.Latest, true);
  const imports = [];
  const args = [];
  let calls = 0;
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "runPtyEntry") {
      calls++;
      for (const p of node.arguments[0].properties) args.push(ts.isSpreadAssignment(p) ? "<spread>" : p.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  assert.deepEqual(imports, ["node-pty", "../../packages/pty-process/index.js"]);
  assert.equal(calls, 1);
  assert.deepEqual(args.sort(), ["env", "execArgv", "parentPort", "platform", "process", "spawn", "stderr"]);
  assert.match(src, /nodePty\.spawn\(file, args, options\)/);
  assert.equal(/PtyService|TerminalProcess|ptyHost/.test(src.replace(/\/\/[^\n]*/g, "")), false, "upstream's terminal service adds VSCODE_* and a nonce (PTY-6)");
});
