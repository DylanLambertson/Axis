// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, test } from "node:test";
import { envSet, isDebugFlag, REFUSED_ENV, runDaemonEntry, type DaemonEntryDeps } from "../src/entry.js";
import { EXIT } from "../src/index.js";
import { FakeParentPort, FakeProcess, FakeTimers, initPayload, platformName, sandbox } from "../testing/entry-harness.js";

/** Every rig's parent port and timers: after the file, each host that started anyway (a regression) is ended, so nothing keeps it running. */
const rigs: Array<{ port: FakeParentPort; timers: FakeTimers }> = [];
after(() => {
  for (const r of rigs) {
    r.port.deliver({ type: "shutdown" });
    r.timers.fire();
  }
});

function rig(over: Partial<DaemonEntryDeps> = {}) {
  const port = new FakeParentPort();
  // The parent's anchor answers, so a host that starts reaches ready and can be shut down (none should start in this file).
  port.reply = (m, deliver) => {
    if (m["type"] === "anchor.get") deliver({ type: "anchor.result", requestId: m["requestId"], anchor: null });
    if (m["type"] === "anchor.put") deliver({ type: "anchor.ack", seq: m["seq"] });
  };
  const proc = new FakeProcess();
  const lines: string[] = [];
  const timers = new FakeTimers();
  rigs.push({ port, timers });
  const deps: DaemonEntryDeps = { timers, parentPort: port, process: proc, env: { PATH: "/usr/bin" }, cwd: process.cwd(), platform: platformName(), execArgv: [], stderr: (l) => void lines.push(l), ...over };
  return { port, proc, lines, deps, timers };
}

/** `p`, or an assertion failure after 5 s: a start that a regression lets run on fails here instead of hanging the file. */
async function within<T>(p: Promise<T>, ms = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_r, reject) => (timer = setTimeout(() => reject(new assert.AssertionError({ message: `still pending after ${ms} ms` })), ms)))]);
  } finally {
    clearTimeout(timer);
  }
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
    assert.equal(await within(h.finished), EXIT.BAD_CONFIG);
    assert.equal(await within(h.started), false);
    assert.deepEqual(proc.exits, [EXIT.BAD_CONFIG]);
    assert.equal(existsSync(box.dataDir), false);
  } finally {
    box.cleanup();
  }
});

test("a debugger or inspector flag, NODE_OPTIONS, NODE_TLS_REJECT_UNAUTHORIZED or NODE_USE_ENV_PROXY refuses before the parent port is touched", async () => {
  for (const [name, over, reason] of [
    ["--inspect", { execArgv: ["--inspect"] }, "debug_flag_refused"],
    ["--inspect-brk", { execArgv: ["--no-warnings", "--inspect-brk=0"] }, "debug_flag_refused"],
    ["--remote-debugging-port", { execArgv: ["--remote-debugging-port=9222"] }, "debug_flag_refused"],
    ["--require", { execArgv: ["--require", "/tmp/x.js"] }, "exec_args_refused"],
    ["--import", { execArgv: ["--import=data:text/javascript,0"] }, "exec_args_refused"],
    ["NODE_OPTIONS", { env: { NODE_OPTIONS: "--require /tmp/x.js" } }, "node_options_refused"],
    ["NODE_TLS_REJECT_UNAUTHORIZED", { env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } }, "tls_override_refused"],
    ["NODE_TLS_REJECT_UNAUTHORIZED=1", { env: { NODE_TLS_REJECT_UNAUTHORIZED: "1" } }, "tls_override_refused"],
    ["NODE_USE_ENV_PROXY", { env: { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://127.0.0.1:9" } }, "env_proxy_refused"],
    ["win32 lower-case tls", { platform: "win32", env: { node_tls_reject_unauthorized: "0" } }, "tls_override_refused"],
    ["win32 mixed-case proxy", { platform: "win32", env: { Node_Use_Env_Proxy: "1" } }, "env_proxy_refused"],
    ["win32 mixed-case options", { platform: "win32", env: { Node_Options: "--require x" } }, "node_options_refused"],
  ] as const) {
    const { port, proc, deps } = rig(over);
    const h = runDaemonEntry(deps);
    assert.equal(await within(h.finished), EXIT.BAD_CONFIG, name);
    assert.equal(port.attached(), false, `${name}: no listener was attached`);
    assert.equal(fatalOf(port)?.["reason"], reason, name);
    assert.deepEqual(proc.exits, [EXIT.BAD_CONFIG], name);
  }
});

test("an empty value, or a lower-case name outside Windows, is not a refusal", async () => {
  for (const [name, over] of [
    ["empty", { env: { NODE_OPTIONS: "", NODE_TLS_REJECT_UNAUTHORIZED: "", NODE_USE_ENV_PROXY: "" } }],
    ["win32 empty", { platform: "win32", env: { node_options: "", Node_Tls_Reject_Unauthorized: "", NODE_USE_ENV_PROXY: "" } }],
    ["linux lower-case", { platform: "linux", env: { node_options: "--require x", node_tls_reject_unauthorized: "0", node_use_env_proxy: "1" } }],
  ] as const) {
    const { port, proc, deps, timers } = rig(over);
    const h = runDaemonEntry(deps);
    assert.equal(port.attached(), true, name);
    timers.fire();
    await within(h.finished); // ends by the init timeout, not by a refusal of the environment
    assert.equal(fatalOf(port)?.["reason"], "init_timeout", name);
    assert.deepEqual(proc.exits, [EXIT.BAD_CONFIG], name);
  }
});

test("envSet: exact on POSIX, any letter case on Windows, never an undefined or empty value", () => {
  assert.equal(envSet({ NODE_USE_ENV_PROXY: "1" }, "NODE_USE_ENV_PROXY", "linux"), true);
  assert.equal(envSet({ node_use_env_proxy: "1" }, "NODE_USE_ENV_PROXY", "darwin"), false);
  assert.equal(envSet({ node_use_env_proxy: "1" }, "NODE_USE_ENV_PROXY", "win32"), true);
  assert.equal(envSet({ node_use_env_proxy: undefined, NODE_USE_ENV_PROXY: "" }, "NODE_USE_ENV_PROXY", "win32"), false);
  assert.equal(envSet({ a: "", node_use_env_proxy: undefined, Node_Use_Env_Proxy: "1" }, "NODE_USE_ENV_PROXY", "win32"), true);
  assert.deepEqual(REFUSED_ENV.map(([n]) => n), ["NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_USE_ENV_PROXY"]);
});

test("no init message: the entry gives up with exit 78 and lets go of the port", async () => {
  const { port, proc, deps, timers } = rig();
  const h = runDaemonEntry(deps);
  timers.fire();
  assert.equal(await within(h.finished), EXIT.BAD_CONFIG);
  assert.equal(await within(h.started), false);
  assert.equal(fatalOf(port)?.["reason"], "init_timeout");
  assert.equal(port.attached(), false, "the listener is gone");
  assert.deepEqual(proc.exits, [EXIT.BAD_CONFIG]);
});

test("the start timer is armed at start; a valid init alone leaves it armed (the pty control port is still due) and its end is pty_required", async () => {
  const box = sandbox();
  try {
    const { port, deps, timers } = rig();
    const h = runDaemonEntry(deps);
    assert.equal(timers.pending(), 1, "armed");
    port.deliver(initPayload(box).message);
    await new Promise((r) => setImmediate(r));
    assert.equal(timers.pending(), 1, "still armed: no pty control port yet");
    timers.fire();
    assert.equal(await within(h.finished), EXIT.BAD_CONFIG);
    assert.equal(fatalOf(port)?.["reason"], "pty_required");
    assert.equal(timers.pending(), 0);
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
      assert.equal(await within(h.finished), EXIT.BAD_CONFIG, JSON.stringify(Object.keys(over)));
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
    assert.equal(await within(h.finished), EXIT.BAD_CONFIG);
    assert.equal(fatalOf(port)?.["reason"], "platform_mismatch");
    assert.equal(existsSync(box.dataDir), false);
  } finally {
    box.cleanup();
  }
});

test("the production wiring without a pty control port fails closed at the bound: exit 78, no data directory, no ready, key in no line", async () => {
  const box = sandbox();
  try {
    const { port, proc, lines, deps, timers } = rig();
    const h = runDaemonEntry(deps); // ports: nothing, and main sends no pty-control (the overlay before PV-X1b)
    const init = initPayload(box);
    port.deliver(init.message);
    timers.fire();
    assert.equal(await within(h.finished), EXIT.BAD_CONFIG);
    assert.equal(await within(h.started), false);
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
    const { port, deps, timers } = rig();
    const h = runDaemonEntry(deps);
    port.deliver(initPayload(box).message);
    port.deliver(initPayload(box, { platform: "nonsense" }).message); // would be an invalid_config if it were read
    timers.fire();
    assert.equal(await within(h.finished), EXIT.BAD_CONFIG);
    assert.equal(fatalOf(port)?.["reason"], "pty_required");
  } finally {
    box.cleanup();
  }
});
