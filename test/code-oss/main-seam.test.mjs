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
const PTY = read("code/electron-main/axisMainPty.ts");
const RENDERER = read("services/daemon/electron-browser/axisDaemonConnection.ts");
const PATCH = readFileSync(new URL("../../code-oss/patches/0210-axis-main-seam.patch", import.meta.url), "utf8");

const importsOf = (source) => {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  return sf.statements.filter((s) => ts.isImportDeclaration(s)).map((s) => s.moduleSpecifier.text);
};

test("the seam reads the anchor store before the first spawn, and the supervisor gets the answers, the MAC and the transfer", () => {
  const prepare = SEAM.indexOf("Promise.all([answers.prepare(), pty.started]).finally(() => started.start())");
  assert.ok(prepare > 0, "start only after prepare and the pty process's start");
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
  assert.match(SEAM, /pty\.shutdown\(\(\) => started\.shutdown\(\)\)\.then\(\(\) => answers\.idle\(\)\)\.finally\(\(\) => answers\.dispose\(\)\)/);
  // No project is registered by main yet: the trust source knows no path (every trust.check is false).
  assert.match(PORTS, /projectPath: \(\) => undefined/);
  assert.match(PORTS, /services\.configuration\.inspect\(key\)/);
});

test("the renderer side imports only upstream IPC helpers and the protocol client", () => {
  assert.deepEqual(importsOf(RENDERER), ["../../../../base/common/uuid.js", "../../../../base/parts/ipc/electron-browser/ipc.mp.js", "../../../packages/protocol/client.js"]);
  assert.match(RENDERER, /acquirePort\('vscode:axisConnect', 'vscode:axisConnectResult', generateUuid\(\)\)/);
  // The main-side modules the seam loads are main's, never the host's composition points.
  for (const spec of [...importsOf(SEAM), ...importsOf(PORTS), ...importsOf(PTY)].filter((s) => s.includes("packages/"))) {
    assert.match(spec, /^\.\.\/\.\.\/packages\/daemon-host\/(supervisor|main\/[a-z-]+)\.js$/, spec);
  }
});

test("patch 0210 passes the instantiation service and still adds 8 lines", () => {
  assert.match(PATCH, /^\+\t\tstartAxisMainSeam\(this\.lifecycleMainService, this\.logService, appInstantiationService\);$/m);
  assert.equal(PATCH.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length, 8);
});

/** The rule breaks of the pty wiring (PV-X1b, docs/design/pty-exec-node.md §6): empty when fine. */
export function ptyWiringViolations(seam, pty) {
  const bad = [];
  const gate = seam.indexOf("if (!shouldStartDaemon(services.environment.isBuilt)) {");
  if (gate < 0 || /shouldStartDaemon\(app\.isPackaged\)/.test(seam)) bad.push("the start gate is not Code OSS's isBuilt");
  const startPty = seam.indexOf("const pty = startAxisPty(config, resolvedShellEnv(services), log, timers);");
  if (!(gate > 0 && startPty > gate)) bad.push("the pty process does not start under the daemon's start gate");
  if ((seam.match(/startAxisPty\(/g) ?? []).length !== 1) bad.push("the pty process is started more than once");
  if (!/const handle: DaemonChild = \{[\s\S]*?\};\s+\/\/[^\n]*\n\s+child\.once\('exit', \(\) => pty\.handover\.daemon\(handle, false\)\);\s+pty\.handover\.daemon\(handle, true\);\s+return handle;/.test(seam)) bad.push("a daemon child is not reported to the control hand-over");
  if (!/fork\(FileAccess\.asFileUri\('vs\/axis\/pty\/node\/axisPtyMain\.js'\)\.fsPath, \[\], \{\s+serviceName: 'axis-pty',\s+env,\s+execArgv: \[\],\s+stdio: 'pipe',\s+\}\)/.test(pty)) bad.push("the pty entry is not forked fixed, with exactly the checked environment, no execArgv and piped stdio");
  if ((pty.match(/utilityProcess\.fork\(/g) ?? []).length !== 1) bad.push("the pty file forks more than one entry");
  if (!/fork: childEnv => forkPty\(childEnv, log\)/.test(pty)) bad.push("the fork does not take the environment createPtySpawn built");
  if (!/onChild: \(child, alive\) => handover\.pty\(child as PtyForkedChild, alive\)/.test(pty)) bad.push("a pty child is not reported to the control hand-over");
  if (!/await shutdownInOrder\(daemonStop, supervisor, timers, DAEMON_STOP_BOUND_MS\);/.test(pty) || !/const DAEMON_STOP_BOUND_MS = DEFAULT_RESTART_POLICY\.stopGraceMs \+ 1_000;/.test(pty)) bad.push("shutdown is not the daemon first, then the pty process, bounded");
  if (/postMessage\(\{ type: 'pty-control'|type: "pty-control"/.test(seam + pty)) bad.push("main posts pty-control outside the hand-over module");
  return bad;
}

test("the pty process starts under the daemon's gate, its fork is fixed, both children reach the hand-over, and shutdown is ordered", () => {
  assert.deepEqual(ptyWiringViolations(SEAM, PTY), []);
});

test("the pty wiring checker finds each way of breaking it", () => {
  const breaks = [
    [SEAM.replace("\tif (!shouldStartDaemon(services.environment.isBuilt)) {", "\tif (false) {"), PTY, "the pty process does not start under the daemon's start gate"],
    [SEAM.replace("shouldStartDaemon(services.environment.isBuilt)", "shouldStartDaemon(app.isPackaged)"), PTY, "the start gate is not Code OSS's isBuilt"],
    [SEAM.replace("\t\t\tpty.handover.daemon(handle, true);\n", ""), PTY, "a daemon child is not reported to the control hand-over"],
    [SEAM.replace("child.once('exit', () => pty.handover.daemon(handle, false));", ""), PTY, "a daemon child is not reported to the control hand-over"],
    [SEAM, PTY.replace("\t\tenv,\n\t\texecArgv: [],", "\t\tenv: { ...process.env, ...env },\n\t\texecArgv: [],"), "the pty entry is not forked fixed, with exactly the checked environment, no execArgv and piped stdio"],
    [SEAM, PTY.replace("execArgv: [],\n\t\tstdio: 'pipe',", "execArgv: ['--inspect'],\n\t\tstdio: 'pipe',"), "the pty entry is not forked fixed, with exactly the checked environment, no execArgv and piped stdio"],
    [SEAM, PTY.replace("fork: childEnv => forkPty(childEnv, log)", "fork: () => forkPty({ ...process.env } as Record<string, string>, log)"), "the fork does not take the environment createPtySpawn built"],
    [SEAM, PTY.replace("onChild: (child, alive) => handover.pty(child as PtyForkedChild, alive),", ""), "a pty child is not reported to the control hand-over"],
    [SEAM, PTY.replace("await shutdownInOrder(daemonStop, supervisor, timers, DAEMON_STOP_BOUND_MS);", "await supervisor.shutdown(); await daemonStop();"), "shutdown is not the daemon first, then the pty process, bounded"],
    [SEAM.replace("return handle;", "child.postMessage({ type: 'pty-control' });\n\t\t\treturn handle;"), PTY, "main posts pty-control outside the hand-over module"],
  ];
  for (const [seam, pty, expected] of breaks) {
    assert.ok(seam !== SEAM || pty !== PTY, `the mutation applies: ${expected}`);
    assert.ok(ptyWiringViolations(seam, pty).includes(expected), expected);
  }
});
