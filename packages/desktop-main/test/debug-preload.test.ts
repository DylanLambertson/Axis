// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// G-28 and the preload contract. Mutants each test kills:
//   G1 a refused switch missed in any form (`--x`, `--x=v`, `-x`, `/x` on Windows, upper case, after `--`); G2 the check run in
//   an unpackaged build, or skipped in a packaged one; G3 argv[0] (the executable) judged; G4 ELECTRON_RUN_AS_NODE or
//   NODE_OPTIONS missed (also in another case on Windows); G5 a switch value in the result; G6 an allowed switch or a positional
//   argument refused; G7 a switch outside the allow-list accepted (`--inspect-brk-node`, any unknown one), or its name echoed raw;
//   P1 the global, a function or a channel renamed or added (pinned); P2 a payload with an extra, missing, accessor, symbol or
//   inherited key accepted; P3 a bad nonce, action, project id or terminal id accepted; P4 a project id on any action but open,
//   or open without one.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEBUG_FLAG_EXIT, IPC_CHANNELS, IPC_REPLY_CHANNELS, PRELOAD_FUNCTIONS, PRELOAD_GLOBAL, debugFlagRefusals, parseConnect, parseOpenExternal,
  PACKAGED_ALLOWED_SWITCHES, REFUSED_SWITCHES, parseProjectAction, parseTerminalPort, switchName,
} from "../src/index.js";

const packaged = { packaged: true, platform: "linux" };
const exe = "/opt/axis/axis";

test("G-28: every form of a refused switch, packaged only", () => {
  assert.equal(DEBUG_FLAG_EXIT, 64);
  for (const a of ["--remote-debugging-port=9222", "--remote-debugging-port", "-remote-debugging-port=1", "--REMOTE-DEBUGGING-PORT=1", "--inspect", "--inspect-brk=0", "--inspect-port=1", "--remote-debugging-pipe", "--js-flags=--expose-gc", "--remote-allow-origins=*"]) {
    assert.notDeepEqual(debugFlagRefusals([exe, a], {}, packaged), [], `G1: ${a}`);
  }
  assert.deepEqual(debugFlagRefusals([exe, "--", "--inspect"], {}, packaged), ["--inspect"], "G1: after --");
  assert.deepEqual(debugFlagRefusals([exe, "/inspect"], {}, { packaged: true, platform: "win32" }), ["--inspect"], "G1: Windows prefix");
  assert.deepEqual(debugFlagRefusals([exe, "/inspect"], {}, packaged), [], "a path argument on Linux is not a switch");
  assert.deepEqual(debugFlagRefusals([exe, "--inspect", "--remote-debugging-port=1"], {}, { packaged: false, platform: "linux" }), [], "G2");
  assert.deepEqual(debugFlagRefusals(["--inspect"], {}, packaged), [], "G3");
  assert.deepEqual(debugFlagRefusals([exe, "--remote-debugging-port=9222", "--inspect=0.0.0.0:9229"], {}, packaged), ["--inspect", "--remote-debugging-port"], "G5: names only, sorted");
  assert.deepEqual(debugFlagRefusals([exe, "--ozone-platform=wayland", "--ozone-platform-hint=auto", "project", "-", "--"], {}, packaged), [], "G6: the allow-list and positional arguments");
});

test("G-28: a packaged build refuses every switch outside the allow-list", () => {
  const exe = "/opt/axis/axis";
  const packaged = { packaged: true, platform: "linux" };
  assert.deepEqual(debugFlagRefusals([exe, "--enable-logging", "--lang=en", "--no-sandbox-ish"], {}, packaged), ["--enable-logging", "--lang", "--no-sandbox-ish"], "G7: unknown switches");
  for (const a of ["--inspect-brk-node=0", "--INSPECT-BRK-NODE", "-inspect-brk-node=127.0.0.1:1", "--remote-debugging-targets=x", "--auto-open-devtools-for-tabs", "--some-future-debug-switch"]) {
    assert.notDeepEqual(debugFlagRefusals([exe, a], {}, packaged), [], `G7: ${a}`);
  }
  assert.deepEqual(debugFlagRefusals([exe, "/inspect-brk-node"], {}, { packaged: true, platform: "win32" }), ["--inspect-brk-node"], "G7: Windows prefix");
  assert.deepEqual(debugFlagRefusals([exe, "--x\u202ey"], {}, packaged), ["--(unprintable)"], "G7: an unknown name is never echoed raw");
  for (const n of REFUSED_SWITCHES) assert.equal(PACKAGED_ALLOWED_SWITCHES.has(n), false, `G7: ${n} is never allowed`);
});

test("G-28: environment", () => {
  assert.deepEqual(debugFlagRefusals([exe], { ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--inspect", HOME: "/h" }, packaged), ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"], "G4");
  assert.deepEqual(debugFlagRefusals([exe], { NODE_OPTIONS: "" }, packaged), ["NODE_OPTIONS"], "G4: set but empty");
  assert.deepEqual(debugFlagRefusals([exe], { node_options: "x" }, { packaged: true, platform: "win32" }), ["NODE_OPTIONS"], "G4: Windows names are case-insensitive");
  assert.deepEqual(debugFlagRefusals([exe], { node_options: "x" }, packaged), []);
  assert.deepEqual(debugFlagRefusals([exe], { NODE_OPTIONS: undefined }, packaged), []);
});

test("switchName", () => {
  assert.equal(switchName("--A=b", "linux"), "a");
  assert.equal(switchName("-", "linux"), undefined);
  assert.equal(switchName("--=x", "linux"), undefined);
  assert.equal(switchName("plain", "win32"), undefined);
  assert.equal(switchName(3, "linux"), undefined);
});

test("preload contract is pinned", () => {
  assert.equal(PRELOAD_GLOBAL, "axis");
  assert.deepEqual(PRELOAD_FUNCTIONS, ["connect", "projectAction", "terminalPort", "openExternal"], "P1");
  assert.deepEqual(IPC_CHANNELS, { connect: "axis:connect", projectAction: "axis:projectAction", terminalPort: "axis:terminalPort", openExternal: "axis:openExternal" }, "P1");
  assert.deepEqual(IPC_REPLY_CHANNELS, { connect: "axis:connectResult", projectAction: "axis:projectActionResult", terminalPort: "axis:terminalPortResult" }, "P1");
  assert.equal(Object.isFrozen(IPC_CHANNELS) && Object.isFrozen(PRELOAD_FUNCTIONS), true);
});

test("parseConnect and parseTerminalPort", () => {
  assert.equal(parseConnect("abc-DEF-123"), "abc-DEF-123");
  for (const n of ["", "a_b", "x".repeat(65), "a b", 5, { nonce: "a" }]) assert.equal(parseConnect(n), undefined, `P3: ${JSON.stringify(n)}`);
  assert.deepEqual(parseTerminalPort({ nonce: "n_1", terminalId: "t1" }), { nonce: "n_1", terminalId: "t1" });
  for (const p of [{ nonce: "n", terminalId: "-t" }, { nonce: "n", terminalId: "../x" }, { nonce: "n" }, { nonce: "n", terminalId: "t", x: 1 }, { nonce: "n n", terminalId: "t" }]) {
    assert.equal(parseTerminalPort(p), undefined, `P2/P3: ${JSON.stringify(p)}`);
  }
});

test("parseProjectAction", () => {
  assert.deepEqual(parseProjectAction({ nonce: "n", action: "add" }), { nonce: "n", action: "add" });
  assert.deepEqual(parseProjectAction({ nonce: "n", action: "open", projectId: "p1" }), { nonce: "n", action: "open", projectId: "p1" });
  for (const a of ["add", "trust", "untrust", "status"]) assert.equal(parseProjectAction({ nonce: "n", action: a, projectId: "p1" }), undefined, `P4: ${a}`);
  assert.equal(parseProjectAction({ nonce: "n", action: "open" }), undefined, "P4");
  for (const p of [
    { nonce: "n", action: "open", projectId: "-p" }, { nonce: "n", action: "open", projectId: "/home/u/repo" }, { nonce: "n", action: "remove" },
    { nonce: "n", action: "add", path: "/x" }, { action: "add" }, { nonce: "", action: "add" }, ["n", "add"], null, "add",
  ]) {
    assert.equal(parseProjectAction(p), undefined, `P2/P3: ${JSON.stringify(p)}`);
  }
  const accessor = { nonce: "n", get action() { return "add"; } };
  assert.equal(parseProjectAction(accessor), undefined, "P2: accessor");
  assert.equal(parseProjectAction(Object.assign(Object.create({ projectId: "p" }), { nonce: "n", action: "open" })), undefined, "P2: inherited");
  assert.equal(parseProjectAction({ nonce: "n", action: "add", [Symbol("s")]: 1 }), undefined, "P2: symbol");
  const hidden = { nonce: "n", action: "add" };
  Object.defineProperty(hidden, "projectId", { value: "p", enumerable: false });
  assert.equal(parseProjectAction(hidden), undefined, "P2: non-enumerable");
});

test("parseOpenExternal", () => {
  assert.equal(parseOpenExternal({ url: "https://e.com/" }), "https://e.com/");
  for (const p of [{ url: "x", from: "user" }, "https://e.com/", {}, null]) assert.equal(parseOpenExternal(p), undefined, `P2: ${JSON.stringify(p)}`);
});
