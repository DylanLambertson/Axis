// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Source pins for main's half of the handshake and the answers (tickets X1b and X1c, docs/design/main-answers.md). The overlay
// cannot run on Linux CI (no Electron), so these tests hold the wiring that the tested modules rely on: the decisions are made in
// packages/daemon-host/src/main/, and the seam must hand them the real inputs, in the right order, with nothing taken from the
// renderer but the nonce.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript6";

const read = (rel) => readFileSync(new URL(`../../code-oss/overlay/src/vs/axis/${rel}`, import.meta.url), "utf8");
const SEAM = read("code/electron-main/axisMainSeam.ts");
const PORTS = read("code/electron-main/axisMainPorts.ts");
const RENDERER = read("services/daemon/electron-browser/axisDaemonConnection.ts");
const PATCH = readFileSync(new URL("../../code-oss/patches/0210-axis-main-seam.patch", import.meta.url), "utf8");

const importsOf = (source) => {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  return sf.statements.filter((s) => ts.isImportDeclaration(s)).map((s) => s.moduleSpecifier.text);
};

test("the seam reads the anchor store before the first spawn, and the supervisor gets the answers, the MAC and the transfer", () => {
  const prepare = SEAM.indexOf("answers.prepare().finally(() => started.start())");
  assert.ok(prepare > 0, "start only after prepare");
  assert.equal((SEAM.match(/\.start\(\)/g) ?? []).length, 1, "no other start");
  assert.match(SEAM, /onRequest: \(message, reply\) => answers\.onRequest\(message, reply\)/);
  assert.match(SEAM, /hmacSha256: \(key, text\) => new Uint8Array\(createHmac\('sha256', key\)\.update\(text, 'utf8'\)\.digest\(\)\)/);
  assert.match(SEAM, /transfer === undefined \? child\.postMessage\(message\) : child\.postMessage\(message, transfer as MessagePortMain\[\]\)/);
  assert.match(SEAM, /createAnchorStore\(safeStorageCipher\(platform\), createAnchorFile\(anchorFilePath\(config\.dataDir\)\)\)/);
  assert.match(SEAM, /services\.windows\.onDidDestroyWindow\(window => broker\.windowClosed\(window\.id\)\)/);
});

test("the connect handler takes only the nonce from the renderer, never echoes a bad one, and answers on the result channel", () => {
  const start = SEAM.indexOf("validatedIpcMain.on('vscode:axisConnect'");
  assert.ok(start > 0);
  const body = SEAM.slice(start, SEAM.indexOf("});", start));
  assert.match(body, /broker\.connect\(connectSender\(services, event\), nonce\)/);
  assert.match(body, /event\.sender\.postMessage\('vscode:axisConnectResult', nonce, \[outcome\.port\]\)/);
  assert.match(body, /outcome\.reason !== 'bad_nonce' && outcome\.reason !== 'destroyed'/);
  // The sender facts come from main: the window lookup, the frame and the main frame.
  assert.match(PORTS, /services\.windows\.getWindowByWebContents\(sender\)/);
  assert.match(PORTS, /frameUrl: event\.senderFrame\?\.url/);
  assert.match(PORTS, /event\.senderFrame === sender\.mainFrame/);
});

test("the cipher is secure only for a real backend, and the dialog confirms only on its Confirm button", () => {
  assert.match(PORTS, /if \(!safeStorage\.isEncryptionAvailable\(\)\) \{\s*return 'unavailable';/);
  assert.match(PORTS, /backend === 'basic_text' \|\| backend === 'unknown' \? 'insecure' : 'secure'/);
  assert.match(PORTS, /buttons: \['Cancel', 'Confirm'\],\s*defaultId: 0,\s*cancelId: 0,/);
  assert.match(PORTS, /return response === 1;/);
  assert.match(PORTS, /confirm: async \(\{ codeWindowId, summary, signal \}\)/);
  assert.match(PORTS, /noLink: true,\s*signal,/);
  assert.match(SEAM, /started\.shutdown\(\)\.then\(\(\) => answers\.idle\(\)\)\.finally\(\(\) => answers\.dispose\(\)\)/);
  // No project is registered by main yet: the trust source knows no path (every trust.check is false).
  assert.match(PORTS, /projectPath: \(\) => undefined/);
  assert.match(PORTS, /services\.configuration\.inspect\(key\)/);
});

test("the renderer side imports only upstream IPC helpers and the protocol client", () => {
  assert.deepEqual(importsOf(RENDERER), ["../../../../base/common/uuid.js", "../../../../base/parts/ipc/electron-browser/ipc.mp.js", "../../../packages/protocol/client.js"]);
  assert.match(RENDERER, /acquirePort\('vscode:axisConnect', 'vscode:axisConnectResult', generateUuid\(\)\)/);
  // The main-side modules the seam loads are main's, never the host's composition points.
  for (const spec of [...importsOf(SEAM), ...importsOf(PORTS)].filter((s) => s.includes("packages/"))) {
    assert.match(spec, /^\.\.\/\.\.\/packages\/daemon-host\/(supervisor|main\/[a-z-]+)\.js$/, spec);
  }
});

test("patch 0210 passes the instantiation service and still adds 8 lines", () => {
  assert.match(PATCH, /^\+\t\tstartAxisMainSeam\(this\.lifecycleMainService, this\.logService, appInstantiationService\);$/m);
  assert.equal(PATCH.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length, 8);
});
