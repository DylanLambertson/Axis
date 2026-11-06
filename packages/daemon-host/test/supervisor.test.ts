// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { EXIT, parseHostConfig, type OutboundMessage } from "../src/index.js";
import { Redactor } from "@axis/audit";
import { DAEMON_ENV_ALLOW, DEFAULT_RESTART_POLICY, DaemonSupervisor, axisDataRoots, daemonEnvironment, shouldStartDaemon, SUPERVISED_EXIT, type DaemonChild, type DaemonSupervisorOptions, type SupervisorEvent } from "../src/supervisor.js";

class FakeChild implements DaemonChild {
  readonly sent: Array<Record<string, unknown>> = [];
  killed = 0;
  closed = false;
  readonly #msg: Array<(m: unknown) => void> = [];
  readonly #exit: Array<(c: number | null) => void> = [];
  postMessage(m: unknown): void {
    if (this.closed) throw new Error("closed");
    this.sent.push(m as Record<string, unknown>);
  }
  kill(): boolean {
    this.killed++;
    return true;
  }
  onMessage(h: (m: unknown) => void): () => void {
    this.#msg.push(h);
    return () => void this.#msg.splice(this.#msg.indexOf(h), 1);
  }
  onExit(h: (c: number | null) => void): () => void {
    this.#exit.push(h);
    return () => void this.#exit.splice(this.#exit.indexOf(h), 1);
  }
  say(m: unknown): void {
    for (const h of [...this.#msg]) h(m);
  }
  exit(code: number | null): void {
    for (const h of [...this.#exit]) h(code);
  }
  ready(): void {
    this.say({ type: "ready", protocolVersion: 1, contracts: [] });
  }
}

/** Manual time: nothing runs until `advance`, so no test depends on a real timer. */
function rig(over: Partial<DaemonSupervisorOptions> = {}) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const children: FakeChild[] = [];
  const events: Array<[SupervisorEvent, Record<string, unknown>]> = [];
  const sup = new DaemonSupervisor({
    spawn: () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    },
    config: { dataDir: "/data/axis", worktreeRoot: "/data/worktrees", platform: "linux", logLevel: "info", devDiagnostics: false },
    randomBytes: (n) => randomBytes(n),
    timers: {
      set: (fn, ms) => {
        const id = nextId++;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clear: (h) => void timers.delete(h as number),
    },
    now: () => now,
    onEvent: (e, f) => void events.push([e, { ...f }]),
    ...over,
  });
  const advance = (ms: number): void => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = target;
  };
  return { sup, children, events, advance, pendingTimers: () => timers.size, last: () => children[children.length - 1] as FakeChild, now: () => now };
}

test("the supervisor's exit codes are the host's", () => {
  assert.deepEqual({ ...SUPERVISED_EXIT }, { OK: EXIT.OK, UNSETTLED: EXIT.UNSETTLED, INTERNAL: EXIT.INTERNAL, LOCK_HELD: EXIT.LOCK_HELD, BAD_CONFIG: EXIT.BAD_CONFIG, DEGRADED: EXIT.DEGRADED });
});

test("start sends init with a config the host accepts and a fresh key per spawn that is never logged", () => {
  const events: unknown[] = [];
  const t = rig({ onEvent: (e, f) => void events.push([e, f]) });
  t.sup.start();
  t.sup.start(); // a second start does nothing
  assert.equal(t.children.length, 1);
  const init = t.last().sent[0] as { type: string; config: Record<string, unknown> };
  assert.equal(init.type, "init");
  const config = parseHostConfig(init.config, new Redactor()); // the host's own strict schema
  assert.equal(config.dataDir, "/data/axis");
  assert.equal(config.devDiagnostics, false);
  assert.equal(config.attestationKey.length, 32);
  assert.equal(JSON.stringify(events).includes(String(init.config["attestationKey"])), false);
  t.last().exit(EXIT.INTERNAL);
  t.advance(DEFAULT_RESTART_POLICY.baseDelayMs);
  const second = (t.last().sent[0] as { config: Record<string, unknown> }).config["attestationKey"];
  assert.notEqual(second, init.config["attestationKey"], "a new key for each host");
});

test("a source that cannot give a random key starts no host", () => {
  const t = rig({ randomBytes: () => new Uint8Array(32) }); // 1 distinct value
  t.sup.start();
  assert.equal(t.children.length, 0, "no host is forked without a key");
  assert.equal(t.sup.state(), "backoff", "a counted crash");
});

test("ready moves starting to running once; an invalid, stale or extra message changes nothing", () => {
  const t = rig();
  t.sup.start();
  assert.equal(t.sup.state(), "starting");
  t.last().say({ type: "ready", protocolVersion: 1, contracts: [], extra: true });
  t.last().say("nonsense");
  assert.equal(t.sup.state(), "starting");
  assert.equal(t.events.filter(([e]) => e === "invalid_message").length, 2);
  t.last().ready();
  assert.equal(t.sup.state(), "running");
  assert.equal(t.pendingTimers(), 0, "the ready timer is gone");
});

test("a degraded ready is reported as degraded with its reason code", () => {
  const t = rig();
  t.sup.start();
  t.last().say({ type: "ready", protocolVersion: 1, contracts: [], degraded: "audit_chain_invalid" });
  assert.deepEqual(t.events.at(-1), ["degraded", { reason: "audit_chain_invalid" }]);
});

test("75, 78 and 79 are never restarted", () => {
  for (const [code, reason] of [[75, "lock_held"], [78, "bad_config"], [79, "degraded"]] as const) {
    const t = rig();
    t.sup.start();
    t.last().exit(code);
    assert.equal(t.sup.state(), "failed", String(code));
    assert.equal(t.sup.failure(), reason);
    t.advance(DEFAULT_RESTART_POLICY.maxDelayMs * 10);
    assert.equal(t.children.length, 1, `${code}: no second spawn`);
    assert.equal(t.pendingTimers(), 0);
  }
});

test("1, 70, 0 without a stop request, another code and a signal are restarted with a doubling delay", () => {
  for (const code of [1, 70, 0, 3, null]) {
    const t = rig();
    t.sup.start();
    t.last().ready();
    t.last().exit(code);
    assert.equal(t.sup.state(), "backoff", String(code));
    t.advance(DEFAULT_RESTART_POLICY.baseDelayMs - 1);
    assert.equal(t.children.length, 1, "not before the delay");
    t.advance(1);
    assert.equal(t.children.length, 2, `${code}: restarted`);
    assert.equal(t.sup.state(), "starting");
  }
  const t = rig();
  t.sup.start();
  const delays: number[] = [];
  for (let i = 0; i < 4; i++) {
    t.last().exit(70);
    let waited = 0;
    while (t.children.length === i + 1) {
      t.advance(1);
      waited++;
    }
    delays.push(waited);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
});

test("the delay is capped, and more crashes than the budget inside the window end in crash_loop and stay down", () => {
  const t = rig({ policy: { maxRestarts: 3, baseDelayMs: 10_000, maxDelayMs: 15_000 } });
  t.sup.start();
  const delays: number[] = [];
  for (let i = 0; i < 3; i++) {
    t.last().exit(70);
    let waited = 0;
    while (t.children.length === i + 1) {
      t.advance(1000);
      waited += 1000;
    }
    delays.push(waited);
  }
  assert.deepEqual(delays, [10_000, 15_000, 15_000]);
  t.last().exit(70);
  assert.equal(t.sup.state(), "failed");
  assert.equal(t.sup.failure(), "crash_loop");
  t.advance(10 * DEFAULT_RESTART_POLICY.windowMs);
  assert.equal(t.children.length, 4, "no further spawn");
});

test("crashes older than the window, or before a stable run, are forgotten", () => {
  const t = rig({ policy: { maxRestarts: 2, baseDelayMs: 1000, windowMs: 100_000, stableMs: 50_000 } });
  t.sup.start();
  t.last().exit(70);
  t.advance(1000);
  t.last().exit(70);
  t.advance(2000);
  assert.equal(t.children.length, 3);
  t.last().ready();
  t.advance(50_000); // stable
  t.last().exit(70);
  assert.equal(t.sup.state(), "backoff", "history cleared by the stable run: this is the first crash again");
  t.advance(1000);
  assert.equal(t.children.length, 4);
  // An unstable run does not clear it.
  t.last().ready();
  t.advance(10);
  t.last().exit(70);
  t.advance(2000);
  t.last().exit(70);
  assert.equal(t.sup.state(), "failed");
  assert.equal(t.sup.failure(), "crash_loop");
});

test("no ready in time kills the child and counts as a crash", () => {
  const t = rig();
  t.sup.start();
  const first = t.last();
  t.advance(DEFAULT_RESTART_POLICY.readyTimeoutMs - 1);
  assert.equal(first.killed, 0);
  t.advance(1);
  assert.equal(first.killed, 1);
  first.exit(null);
  assert.equal(t.sup.state(), "backoff");
});

test("a spawn that throws is a counted crash, not silence", () => {
  let fail = true;
  const t = rig({
    spawn: () => {
      if (fail) throw new Error("no entry");
      return new FakeChild();
    },
  });
  t.sup.start();
  assert.equal(t.sup.state(), "backoff");
  fail = false;
  t.advance(DEFAULT_RESTART_POLICY.baseDelayMs);
  assert.equal(t.sup.state(), "starting");
});

test("shutdown posts the message first, waits for the exit, and does not restart whatever the code", async () => {
  for (const code of [0, 1, 70, null]) {
    const t = rig();
    t.sup.start();
    t.last().ready();
    const child = t.last();
    let done = false;
    const p = t.sup.shutdown().then(() => void (done = true));
    assert.deepEqual(child.sent.at(-1), { type: "shutdown" });
    assert.equal(child.killed, 0, "no kill while it can still drain");
    await Promise.resolve();
    assert.equal(done, false, "waits for the exit");
    child.exit(code);
    await p;
    assert.equal(t.sup.state(), "stopped");
    t.advance(DEFAULT_RESTART_POLICY.maxDelayMs * 10);
    assert.equal(t.children.length, 1, `code ${code}: no restart after a stop`);
    assert.equal(t.pendingTimers(), 0);
  }
});

test("a host that ignores shutdown is killed after the grace, and the stop still ends", async () => {
  const t = rig();
  t.sup.start();
  t.last().ready();
  const child = t.last();
  const p = t.sup.shutdown();
  t.advance(DEFAULT_RESTART_POLICY.stopGraceMs - 1);
  assert.equal(child.killed, 0);
  t.advance(1);
  assert.equal(child.killed, 1);
  await p;
  assert.equal(t.sup.state(), "stopped");
});

test("shutdown during a backoff cancels the restart; before start and after a failure it just resolves", async () => {
  const t = rig();
  t.sup.start();
  t.last().exit(70);
  assert.equal(t.sup.state(), "backoff");
  await t.sup.shutdown();
  t.advance(DEFAULT_RESTART_POLICY.maxDelayMs);
  assert.equal(t.children.length, 1, "the pending restart never ran");
  assert.equal(t.sup.state(), "stopped");
  const idle = rig();
  await idle.sup.shutdown();
  assert.equal(idle.sup.state(), "stopped");
  idle.sup.start();
  assert.equal(idle.children.length, 0, "a stopped supervisor does not start again");
  const failed = rig();
  failed.sup.start();
  failed.last().exit(78);
  await failed.sup.shutdown();
  assert.equal(failed.sup.state(), "failed", "a failure stays reported");
});

test("a message from an old host is ignored; requests go to onRequest and go unanswered without it", () => {
  const asked: OutboundMessage[] = [];
  const t = rig({ onRequest: (m, reply) => (asked.push(m), reply({ type: "anchor.result", requestId: "r1", anchor: null })) });
  t.sup.start();
  const old = t.last();
  old.exit(70);
  t.advance(DEFAULT_RESTART_POLICY.baseDelayMs);
  const fresh = t.last();
  old.say({ type: "anchor.get", requestId: "stale" });
  assert.equal(asked.length, 0, "stale generation");
  fresh.say({ type: "anchor.get", requestId: "r1" });
  assert.equal(asked.length, 1);
  assert.deepEqual(fresh.sent.at(-1), { type: "anchor.result", requestId: "r1", anchor: null });
  assert.equal(old.sent.length, 1, "nothing is sent to the old host");

  const silent = rig();
  silent.sup.start();
  silent.last().say({ type: "anchor.get", requestId: "r2" });
  assert.equal(silent.last().sent.length, 1, "only the init: no answer without a handler (a refusal on the host's side)");
  assert.ok(silent.events.some(([e, f]) => e === "unanswered_request" && f["reason"] === "anchor.get"));
});

test("a throwing request handler or observer cannot break the state machine", () => {
  const t = rig({ onRequest: () => { throw new Error("boom"); }, onEvent: () => { throw new Error("boom"); }, onStateChange: () => { throw new Error("boom"); } });
  t.sup.start();
  t.last().say({ type: "trust.check", requestId: "r", windowId: "w", workspaceId: "ws", projectId: "p" });
  t.last().ready();
  assert.equal(t.sup.state(), "running");
});

test("the daemon's environment is the allow-list and nothing else: no NODE_OPTIONS, no debug or Electron variable, no secret", () => {
  const source = { PATH: "/usr/bin", HOME: "/home/u", NODE_OPTIONS: "--inspect", ELECTRON_RUN_AS_NODE: "1", VSCODE_NONCE: "n", GIT_ASKPASS: "x", SSH_AUTH_SOCK: "/s", GITHUB_TOKEN: "t", AXIS_TOKEN_LIKE: "y", LANG: undefined };
  assert.deepEqual(daemonEnvironment(source), { PATH: "/usr/bin", HOME: "/home/u" });
  // The list itself is pinned: adding a name (a secret or an agent socket) must be a visible change to this test.
  assert.deepEqual([...DAEMON_ENV_ALLOW], ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_RUNTIME_DIR", "PATHEXT", "WINDIR", "COMSPEC", "USERNAME", "HOMEDRIVE", "HOMEPATH"]);
  assert.deepEqual(daemonEnvironment({}), {});
});

test("the data roots follow D-3 on each platform (not Electron's userData), with both under one base", () => {
  assert.deepEqual(axisDataRoots("darwin", {}, "/Users/u"), { dataDir: "/Users/u/Library/Application Support/Axis/daemon", worktreeRoot: "/Users/u/Library/Application Support/Axis/worktrees" });
  assert.deepEqual(axisDataRoots("darwin", { XDG_DATA_HOME: "/x", LOCALAPPDATA: "C:\\x" }, "/Users/u/"), { dataDir: "/Users/u/Library/Application Support/Axis/daemon", worktreeRoot: "/Users/u/Library/Application Support/Axis/worktrees" }, "macOS ignores the other platforms' variables; a trailing slash is dropped");
  assert.deepEqual(axisDataRoots("linux", {}, "/home/u"), { dataDir: "/home/u/.local/share/Axis/daemon", worktreeRoot: "/home/u/.local/share/Axis/worktrees" });
  assert.deepEqual(axisDataRoots("linux", { XDG_DATA_HOME: "/data/xdg/" }, "/home/u"), { dataDir: "/data/xdg/Axis/daemon", worktreeRoot: "/data/xdg/Axis/worktrees" });
  for (const bad of ["", "relative/dir", "~/x", "/a\0b"]) assert.equal(axisDataRoots("linux", { XDG_DATA_HOME: bad }, "/home/u").dataDir, "/home/u/.local/share/Axis/daemon", `XDG_DATA_HOME ${JSON.stringify(bad)} is ignored`);
  assert.deepEqual(axisDataRoots("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "C:\\Users\\u"), { dataDir: "C:\\Users\\u\\AppData\\Local\\Axis\\daemon", worktreeRoot: "C:\\Users\\u\\AppData\\Local\\Axis\\worktrees" });
  assert.deepEqual(axisDataRoots("win32", { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "C:\\Users\\u"), { dataDir: "C:\\Users\\u\\AppData\\Local\\Axis\\daemon", worktreeRoot: "C:\\Users\\u\\AppData\\Local\\Axis\\worktrees" }, "never Roaming");
  assert.equal(axisDataRoots("win32", { LOCALAPPDATA: "relative" }, "C:\\Users\\u").dataDir, "C:\\Users\\u\\AppData\\Local\\Axis\\daemon");
});

test("the daemon is started in unpackaged builds only, until the real ports exist", () => {
  assert.equal(shouldStartDaemon(false), true);
  assert.equal(shouldStartDaemon(true), false);
});
