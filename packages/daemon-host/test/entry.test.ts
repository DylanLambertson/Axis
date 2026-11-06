// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { isDebugFlag, runDaemonEntry, type DaemonEntryDeps } from "../src/entry.js";
import { EXIT } from "../src/index.js";
import { FakeParentPort, FakeProcess, FakeTimers, initPayload, platformName, sandbox } from "../testing/entry-harness.js";

function rig(over: Partial<DaemonEntryDeps> = {}) {
  const port = new FakeParentPort();
  const proc = new FakeProcess();
  const lines: string[] = [];
  const timers = new FakeTimers();
  const deps: DaemonEntryDeps = { timers, parentPort: port, process: proc, env: { PATH: "/usr/bin" }, cwd: process.cwd(), platform: platformName(), execArgv: [], stderr: (l) => void lines.push(l), ...over };
  return { port, proc, lines, deps, timers };
}

const fatalOf = (port: FakeParentPort): Record<string, unknown> | undefined => port.posted.find((m) => m["type"] === "fatal");

test("isDebugFlag matches every spelling that opens an inspector, and nothing else", () => {
  for (const f of ["--inspect", "--inspect=0", "--inspect-brk=9229", "--inspect-port=1", "--INSPECT", "--debug-port=1", "--remote-debugging-port=9222"]) assert.equal(isDebugFlag(f), true, f);
  for (const f of ["--max-old-space-size=100", "--enable-source-maps", "inspect", "--no-warnings"]) assert.equal(isDebugFlag(f), false, f);
});

test("outside a utility process (no parent port) the entry refuses with exit 78 and creates nothing", async () => {
  const box = sandbox();
  try {
    const { proc, deps } = rig({ parentPort: undefined });
    const h = runDaemonEntry(deps);
    assert.equal(await h.finished, EXIT.BAD_CONFIG);
    assert.equal(await h.started, false);
    assert.deepEqual(proc.exits, [EXIT.BAD_CONFIG]);
    assert.equal(existsSync(box.dataDir), false);
  } finally {
    box.cleanup();
  }
});

test("a debugger or inspector flag, or NODE_OPTIONS, refuses before the parent port is touched", async () => {
  for (const [name, over, reason] of [
    ["--inspect", { execArgv: ["--inspect"] }, "debug_flag_refused"],
    ["--inspect-brk", { execArgv: ["--no-warnings", "--inspect-brk=0"] }, "debug_flag_refused"],
    ["--remote-debugging-port", { execArgv: ["--remote-debugging-port=9222"] }, "debug_flag_refused"],
    ["--require", { execArgv: ["--require", "/tmp/x.js"] }, "exec_args_refused"],
    ["--import", { execArgv: ["--import=data:text/javascript,0"] }, "exec_args_refused"],
    ["NODE_OPTIONS", { env: { NODE_OPTIONS: "--require /tmp/x.js" } }, "node_options_refused"],
  ] as const) {
    const { port, proc, deps } = rig(over);
    const h = runDaemonEntry(deps);
    assert.equal(await h.finished, EXIT.BAD_CONFIG, name);
    assert.equal(port.attached(), false, `${name}: no listener was attached`);
    assert.equal(fatalOf(port)?.["reason"], reason, name);
    assert.deepEqual(proc.exits, [EXIT.BAD_CONFIG], name);
  }
});

test("an empty NODE_OPTIONS is not a refusal", async () => {
  const { port, proc, deps, timers } = rig({ env: { NODE_OPTIONS: "" } });
  const h = runDaemonEntry(deps);
  assert.equal(port.attached(), true);
  timers.fire();
  await h.finished; // ends by the init timeout, not by a refusal of the environment
  assert.equal(fatalOf(port)?.["reason"], "init_timeout");
  assert.deepEqual(proc.exits, [EXIT.BAD_CONFIG]);
});

test("no init message: the entry gives up with exit 78 and lets go of the port", async () => {
  const { port, proc, deps, timers } = rig();
  const h = runDaemonEntry(deps);
  timers.fire();
  assert.equal(await h.finished, EXIT.BAD_CONFIG);
  assert.equal(await h.started, false);
  assert.equal(fatalOf(port)?.["reason"], "init_timeout");
  assert.equal(port.attached(), false, "the listener is gone");
  assert.deepEqual(proc.exits, [EXIT.BAD_CONFIG]);
});

test("the init timer is armed at start and cleared by the first init, a refusal or the release", async () => {
  const box = sandbox();
  try {
    const { port, deps, timers } = rig();
    const h = runDaemonEntry(deps);
    assert.equal(timers.pending(), 1, "armed");
    port.deliver(initPayload(box).message);
    await h.finished;
    assert.equal(timers.pending(), 0, "cleared once init arrived");
    assert.equal(timers.cleared.length >= 1, true);
  } finally {
    box.cleanup();
  }
});

test("an invalid init (unknown key, relative path) is exit 78 and leaves no directory", async () => {
  const box = sandbox();
  try {
    for (const over of [{ extra: 1 }, { dataDir: "relative/dir" }, { attestationKey: "short" }]) {
      const { port, proc, deps } = rig();
      const h = runDaemonEntry(deps);
      port.deliver(initPayload(box, over).message);
      assert.equal(await h.finished, EXIT.BAD_CONFIG, JSON.stringify(Object.keys(over)));
      assert.equal(fatalOf(port)?.["reason"], "invalid_config");
      assert.deepEqual(proc.exits, [EXIT.BAD_CONFIG]);
    }
    assert.equal(existsSync(box.dataDir), false);
  } finally {
    box.cleanup();
  }
});

test("a platform that is not the process's own is refused", async () => {
  const box = sandbox();
  try {
    const { port, deps } = rig();
    const other = platformName() === "linux" ? "win32" : "linux";
    const h = runDaemonEntry(deps);
    port.deliver(initPayload(box, { platform: other }).message);
    assert.equal(await h.finished, EXIT.BAD_CONFIG);
    assert.equal(fatalOf(port)?.["reason"], "platform_mismatch");
    assert.equal(existsSync(box.dataDir), false);
  } finally {
    box.cleanup();
  }
});

test("the production wiring (no pty process, no pty git runner, no snapshotter) fails closed: exit 78, no data directory, no ready, key in no line", async () => {
  const box = sandbox();
  try {
    const { port, proc, lines, deps } = rig();
    const h = runDaemonEntry(deps); // ports: nothing, as the overlay entry passes today
    const init = initPayload(box);
    port.deliver(init.message);
    assert.equal(await h.finished, EXIT.BAD_CONFIG);
    assert.equal(await h.started, false);
    assert.equal(fatalOf(port)?.["reason"], "pty_required");
    assert.equal(port.typesPosted().includes("ready"), false);
    assert.equal(port.typesPosted().includes("anchor.get"), false, "nothing was asked of the parent: startup never began");
    assert.equal(existsSync(box.dataDir), false, "no lock, directory or database");
    assert.deepEqual(proc.exits, [EXIT.BAD_CONFIG]);
    const everything = JSON.stringify([...lines, ...port.posted]);
    assert.equal(everything.includes(init.key.toString("base64url")), false, "the attestation key is in no log line and no message");
    assert.ok(lines.some((l) => l.includes("pty_required")));
    assert.equal(proc.listenerCount("SIGTERM"), 0);
  } finally {
    box.cleanup();
  }
});

test("a second init is ignored and the first one decides", async () => {
  const box = sandbox();
  try {
    const { port, deps } = rig();
    const h = runDaemonEntry(deps);
    port.deliver(initPayload(box).message);
    port.deliver(initPayload(box, { platform: "nonsense" }).message); // would be an invalid_config if it were read
    assert.equal(await h.finished, EXIT.BAD_CONFIG);
    assert.equal(fatalOf(port)?.["reason"], "pty_required");
  } finally {
    box.cleanup();
  }
});
