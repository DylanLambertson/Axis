// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// NET-GATE (docs/design/net-gate.md): the static scan of the overlay, the patch series and the web host guards, and the
// packaged-build check run against fake builds. Every rule has a fixture that must fail.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkNetGate, scanOverlaySource, scanPatchText } from "../../scripts/code-oss/net-gate.mjs";
import { DEBUG_FLAGS, EXIT_FAIL, EXIT_OK, EXIT_SKIP, SKIP_DIAGNOSTIC, exitCodeOf, listenersOfTree, parseLsofListeners, parseProcNet, processTree, runChecks } from "../../scripts/code-oss/check-net-packaged.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const FAKE = join(here, "fixtures", "net-gate-fake-app.mjs");
const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));
const temp = () => { const d = mkdtempSync(join(tmpdir(), "axis-net-test-")); temps.push(d); return d; };

/** A repository root holding a copy of the real overlay, patches and web config, for mutation. */
function repoCopy() {
  const dir = temp();
  cpSync(join(root, "code-oss", "overlay", "src"), join(dir, "code-oss", "overlay", "src"), { recursive: true });
  cpSync(join(root, "code-oss", "patches"), join(dir, "code-oss", "patches"), { recursive: true });
  cpSync(join(root, "packages", "daemon-host", "src"), join(dir, "packages", "daemon-host", "src"), { recursive: true });
  return dir;
}
const text = (v) => v.map((x) => x.text).join("\n");

test("the real repository passes the static gate", () => {
  assert.deepEqual(checkNetGate(root), []);
  assert.deepEqual(checkNetGate(repoCopy()), []);
});

test("overlay source that opens a listener, loads a socket module or the web host is refused", () => {
  const bad = {
    "import net": 'import net from "node:net";',
    "import http bare": 'import { createServer as c } from "http";',
    "import inspector": 'import * as i from "node:inspector";',
    "import web host": 'import { startWebHost } from "../../packages/daemon-host/web/index.js";',
    "import reh server": 'import "../../server/node/serverMain.js";',
    "export from": 'export * from "node:https";',
    "dynamic import": 'void import("node:tls");',
    "require": 'const x = require("node:dgram");',
    "computed require": "const x = require(name);",
    "listen call": "server.listen(8080);",
    "createServer call": "createServer(() => {});",
    "startWebHost call": "startWebHost({ enabled: true });",
    "inspector open": "inspector.open(9229);",
    "remote debugging flag": 'const a = ["--remote-debugging-port=9222"];',
    "inspect flag": 'child.fork(file, [], { execArgv: ["--inspect=0"] });',
    "inspect-brk template": "const a = `--inspect-brk=${port}`;",
  };
  for (const [name, source] of Object.entries(bad)) assert.notEqual(scanOverlaySource(source, "x.ts").length, 0, name);
  for (const ok of ['import { createHmac } from "node:crypto";', 'const note = "inspect the run";', "const s = new Set(); s.add(1);", "emitter.on('listening', f);"]) {
    assert.deepEqual(scanOverlaySource(ok, "x.ts"), [], ok);
  }
});

test("the static scan walks the overlay, skips tests, and fails closed on links and a missing tree", () => {
  const dir = repoCopy();
  const target = join(dir, "code-oss", "overlay", "src", "vs", "axis", "daemon", "node", "axisDaemonMain.ts");
  const original = readFileSync(target, "utf8");
  writeFileSync(target, `${original}\nimport net from "node:net";\n`);
  assert.match(text(checkNetGate(dir)), /node:net/);
  writeFileSync(target, original);
  // A violation in a test file is not scanned: tests may name flags to refuse them.
  const testFile = join(dir, "code-oss", "overlay", "src", "vs", "axis", "test", "browser", "flags.test.ts");
  writeFileSync(testFile, 'const a = "--inspect";');
  assert.deepEqual(checkNetGate(dir), []);
  try {
    symlinkSync(target, join(dir, "code-oss", "overlay", "src", "vs", "axis", "link.ts"));
    assert.match(text(checkNetGate(dir)), /symbolic link/);
  } catch (e) { if (e.code !== "EPERM") throw e; }
  const empty = temp();
  assert.match(text(checkNetGate(empty)), /missing: nothing was checked/);
  const bare = repoCopy();
  rmSync(join(bare, "code-oss", "overlay", "src"), { recursive: true });
  mkdirSync(join(bare, "code-oss", "overlay", "src"), { recursive: true });
  writeFileSync(join(bare, "code-oss", "overlay", "src", "README.md"), "x");
  assert.match(text(checkNetGate(bare)), /holds no source files/);
});

test("a patch that adds a listener or a debugging flag is refused; removed and context lines are not", () => {
  const add = (l) => `--- a/x\n+++ b/x\n@@ -1 +1 @@\n context\n-old\n+${l}\n`;
  for (const l of ["server.listen(1)", "const a = '--inspect=1';", "import net from 'node:net';", "startWebHost(c)", "app.commandLine.appendSwitch('remote-debugging-port', '9222')", "import x from 'daemon-host/web/index.js'"]) {
    assert.notEqual(scanPatchText(add(l), "2999-x.patch").length, 0, l);
  }
  assert.deepEqual(scanPatchText("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-server.listen(1)\n server.listen(2)\n+const ok = 1;\n", "p.patch"), []);
  // A `+++` file header is not added content, even when the path names a refused module.
  assert.equal(scanPatchText("--- a/x\n+++ b/daemon-host/web/server.ts\n", "p.patch").length, 0);
  const dir = repoCopy();
  writeFileSync(join(dir, "code-oss", "patches", "2999-x.patch"), add("server.listen(1)"));
  assert.match(text(checkNetGate(dir)), /listen/);
});

test("the web host guards: enabled: true is required, no default config, nothing outside src/web names the host", () => {
  const dir = repoCopy();
  const config = join(dir, "packages", "daemon-host", "src", "web", "config.ts");
  const original = readFileSync(config, "utf8");
  assert.match(original, /enabled: z\.literal\(true\)/);
  writeFileSync(config, original.replace("enabled: z.literal(true)", "enabled: z.boolean()"));
  assert.match(text(checkNetGate(dir)), /enabled: true/);
  writeFileSync(config, original.replace("enabled: z.literal(true)", "enabled: z.literal(true).default(true)"));
  assert.match(text(checkNetGate(dir)), /default that could start it/);
  writeFileSync(config, `${original}\nexport const DEFAULT_WEB_CONFIG = { enabled: true };\n`);
  assert.match(text(checkNetGate(dir)), /default that could start it/);
  writeFileSync(config, original);
  const host = join(dir, "packages", "daemon-host", "src", "host.ts");
  writeFileSync(host, `${readFileSync(host, "utf8")}\nvoid startWebHost;\n`);
  assert.match(text(checkNetGate(dir)), /outside src\/web/);
});

test("the static gate runs as a script and exits 1 on a violation", () => {
  const script = join(root, "scripts", "code-oss", "net-gate.mjs");
  assert.equal(spawnSync(process.execPath, [script, "--root", root]).status, 0);
  const dir = repoCopy();
  writeFileSync(join(dir, "code-oss", "overlay", "src", "vs", "axis", "x.ts"), "server.listen(1);");
  assert.equal(spawnSync(process.execPath, [script, "--root", dir], { encoding: "utf8" }).status, 1);
});

test("socket listings parse: lsof and /proc/net/tcp, the process tree", () => {
  assert.deepEqual(parseLsofListeners("p10\nn127.0.0.1:9222\np11\nn*:80\nn[::1]:5000\n", [10, 99]), [{ pid: 10, address: "127.0.0.1:9222", port: 9222 }]);
  const proc = "  sl  local_address rem_address st tx rx tr tm retr uid timeout inode\n   0: 0100007F:2406 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 4242 1\n   1: 0100007F:2407 0100007F:9999 01 00000000:00000000 00:00000000 00000000 0 0 4243 1\n";
  assert.deepEqual([...parseProcNet(proc)], [["4242", { address: "0100007F", port: 9222 }]]);
  assert.deepEqual(processTree("1 0\n2 1\n3 2\n4 9\n", 1), [1, 2, 3]);
});

test("without a packaged build the check skips with a diagnostic and never passes", async () => {
  const r = await runChecks({});
  assert.equal(r.status, "skip");
  assert.equal(r.diagnostic, SKIP_DIAGNOSTIC);
  assert.equal(exitCodeOf("skip"), EXIT_SKIP);
  assert.equal(exitCodeOf("pass"), EXIT_OK);
  assert.equal(exitCodeOf("fail"), EXIT_FAIL);
  const env = { ...process.env };
  delete env.AXIS_PACKAGED_APP;
  const run = spawnSync(process.execPath, [join(root, "scripts", "code-oss", "check-net-packaged.mjs")], { encoding: "utf8", env });
  assert.equal(run.status, EXIT_SKIP);
  assert.match(run.stderr, /needs a packaged build/);
  assert.equal(spawnSync(process.execPath, [join(root, "scripts", "code-oss", "check-net-packaged.mjs"), "--bogus"], { encoding: "utf8", env }).status, EXIT_FAIL);
});

test("the packaged check covers exactly the four debugging flags", () => {
  assert.deepEqual([...DEBUG_FLAGS], ["--remote-debugging-port", "--inspect", "--inspect-brk", "--inspect-extensions"]);
});

const canList = listenersOfTree(process.pid) !== null;
const check = (mode, listeners) => runChecks({ app: process.execPath, appArgs: [FAKE, mode], settleMs: 600, ...(listeners === undefined ? {} : { listeners }) });
const byName = (r, name) => r.results.find((x) => x.name === name);

test("a build that opens nothing and ignores the flags passes", { skip: canList ? false : "this host cannot list sockets" }, async () => {
  const r = await check("clean");
  assert.deepEqual(r.results.map((x) => x.status), ["pass", ...DEBUG_FLAGS.map(() => "pass")]);
  assert.equal(r.status, "pass");
});

test("a build that honours a debugging flag fails that flag only", async () => {
  const r = await check("honour", () => []);
  assert.equal(r.status, "fail");
  for (const flag of DEBUG_FLAGS) assert.equal(byName(r, `${flag} refused`).status, "fail", flag);
  assert.equal(byName(r, "plain run: no listener").status, "pass");
});

test("a build that always listens fails the plain-run check, from the real socket listing", { skip: canList ? false : "this host cannot list sockets" }, async () => {
  const r = await check("listen");
  assert.equal(byName(r, "plain run: no listener").status, "fail");
  assert.match(byName(r, "plain run: no listener").detail, /127\.0\.0\.1:\d+|0100007F/);
  for (const flag of DEBUG_FLAGS) assert.equal(byName(r, `${flag} refused`).status, "pass");
});

test("a build that exits, or a host that cannot list sockets, is never a pass", async () => {
  const exited = await check("exit", () => []);
  assert.equal(byName(exited, "plain run: no listener").status, "fail");
  const blind = await check("clean", () => null);
  assert.equal(byName(blind, "plain run: no listener").status, "skip");
  assert.equal(blind.status, "skip");
});
