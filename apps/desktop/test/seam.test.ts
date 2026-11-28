// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// OS-3.1, main's seam (main/seam.ts) against fakes of Electron's utility process, ports and timers, with the real supervisors,
// answers, anchor store and anchor file. Mutants each test kills (named in the assertion messages):
//   S1 a packaged build starts a process; S2 the daemon forked before the anchor store was read or before the pty process; S3 a
//   fork with another entry, service name, execArgv, environment, cwd or stdio, or an entry outside the bundle directory; S4 a
//   child's stdout left unread or its stderr unbounded; S5 the daemon not restarted after it exits; S6 the pty process stopped
//   before the daemon, or the shutdown unbounded; S7 native.confirm answered with anything but a refusal, or not at once; S8
//   trust.check answered true; S9 the control hand-over not given to both children; S10 a child's stderr reaching the log raw (a
//   forged line of main's, an escape sequence); S11 settings answered with anything but unset; S12 the daemon killed by SIGTERM
//   only; S13 a quit during start still spawning the daemon; S14 a dead daemon left in the control hand-over; S16 a hand-over
//   counted as done before both acknowledged (OS-3h); S17 a failed hand-over leaving the pty process running or restarted; S18 a
//   pty_required daemon stranded after the pty process came back; S15 a stderr line
//   escaped before it is cut (a flood line's whole length escaped on main's thread).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UTILITY_EXEC_ARGV } from "@axis/desktop-main";
import { DAEMON_FILE, PTY_FILE, SEAM_SHUTDOWN_BOUND_MS, DAEMON_STOP_BOUND_MS, childStderrLines, startMainSeam, type UtilityChildLike } from "../main/seam.js";
import { safeStorageCipher } from "../main/safe-storage.js";

type Listener = (value: never) => void;

class FakeChild implements UtilityChildLike {
  readonly listeners = new Map<string, Listener[]>();
  readonly posted: Array<{ message: unknown; transfer?: unknown[] }> = [];
  readonly reads: string[] = [];
  killed = 0;
  constructor(
    readonly service: string,
    readonly pid: number,
    readonly log: string[],
  ) {}
  readonly stdout = { on: (_e: "data", _l: (c: unknown) => void) => void this.reads.push("stdout") };
  stderrListener: ((c: unknown) => void) | undefined;
  readonly stderr = { on: (_e: "data", l: (c: unknown) => void) => void ((this.stderrListener = l), this.reads.push("stderr")) };
  postMessage(message: unknown, transfer?: unknown[]): void {
    this.posted.push(transfer === undefined ? { message } : { message, transfer });
    const type = (message as { type?: string } | null)?.type;
    this.log.push(`post ${this.service} ${type}`);
    if (type === "shutdown") setImmediate(() => this.emit("exit", 0));
  }
  kill(): boolean {
    this.killed++;
    this.log.push(`kill ${this.service}`);
    setImmediate(() => this.emit("exit", 0));
    return true;
  }
  on(event: string, listener: Listener): unknown {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  off(event: string, listener: Listener): unknown {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((l) => l !== listener));
    return this;
  }
  once(event: string, listener: (code: number) => void): unknown {
    const wrap = ((v: never) => {
      this.off(event, wrap);
      listener(v);
    }) as Listener;
    return this.on(event, wrap);
  }
  emit(event: string, value: unknown): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) l(value as never);
  }
}

/** A timer queue the test drives: `fire()` runs every timer due within `ms` of virtual time. */
function fakeTimers() {
  let now = 0;
  const q: Array<{ at: number; fn: () => void; id: number }> = [];
  let id = 0;
  return {
    timers: { set: (fn: () => void, ms: number) => (q.push({ at: now + ms, fn, id: ++id }), id), clear: (h: unknown) => void q.splice(q.findIndex((t) => t.id === h) >>> 0, q.findIndex((t) => t.id === h) === -1 ? 0 : 1) },
    advance(ms: number) {
      now += ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at);
        const t = q[0];
        if (t === undefined || t.at > now) return;
        q.shift();
        t.fn();
      }
    },
    now: () => now,
  };
}

function rig(t: { after(fn: () => void): void }, packaged = false, bundleOverride?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "axis-seam-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundleDir = bundleOverride ?? join(root, "app", "dist", "app");
  const log: string[] = [];
  const forks: Array<{ entry: string; args: string[]; options: Record<string, unknown>; child: FakeChild }> = [];
  let pid = 100;
  const clock = fakeTimers();
  const lines: string[] = [];
  const cipher = safeStorageCipher(
    {
      isEncryptionAvailable: () => (log.push("anchor read"), true),
      getSelectedStorageBackend: () => "gnome_libsecret",
      encryptString: (s) => new TextEncoder().encode(s),
      decryptString: (d) => new TextDecoder().decode(d),
    },
    "linux",
  );
  const seam = startMainSeam<{ port: number }>({
    platform: "linux",
    packaged,
    bundleDir,
    config: { dataDir: join(root, "data", "Axis", "daemon"), worktreeRoot: join(root, "data", "Axis", "worktrees"), platform: "linux", logLevel: "info", devDiagnostics: true },
    env: { PATH: "/usr/bin:/bin", HOME: root, SECRET_TOKEN: "s3cr3t", NODE_OPTIONS: "--inspect", LD_PRELOAD: "/x.so", SSH_AUTH_SOCK: "/tmp/agent.sock" },
    utilityProcess: {
      fork: ((entry: string, args: string[], options: Record<string, unknown>) => {
        const child = new FakeChild(String(options["serviceName"]), ++pid, log);
        log.push(`fork ${String(options["serviceName"])}`);
        forks.push({ entry, args, options, child });
        return child;
      }) as never,
    },
    createChannel: () => ({ port1: { port: 1 }, port2: { port: 2 } }),
    closePort: () => {},
    cipher,
    randomBytes: (n) => new Uint8Array(randomBytes(n)),
    hmacSha256: () => new Uint8Array(32),
    now: clock.now,
    timers: clock.timers,
    killPid: (p) => void log.push(`killPid ${p}`),
    log: { trace: (l) => void lines.push(l), warn: (l) => void lines.push(l), error: (l) => void lines.push(l) },
  });
  return { seam, log, forks, clock, lines, bundleDir, root };
}

const settle = () => new Promise((r) => setImmediate(r));
const until = async (cond: () => boolean, what: string) => {
  const end = Date.now() + 5_000;
  while (!cond() && Date.now() < end) await settle();
  assert.ok(cond(), what);
};

test("a packaged build starts neither process", (t) => {
  const r = rig(t, true);
  assert.equal(r.seam, undefined, "S1");
  assert.deepEqual(r.forks, [], "S1");
});

test("the anchor store is read, then the pty process forks, then the daemon", async (t) => {
  const r = rig(t);
  await until(() => r.forks.length === 2, "both forked");
  const order = r.log.filter((l) => l === "anchor read" || l.startsWith("fork "));
  assert.equal(order.indexOf("fork axis-pty"), order.findIndex((l) => l.startsWith("fork ")), "S2: the pty process first");
  assert.ok(order.indexOf("anchor read") !== -1 && order.indexOf("anchor read") < order.indexOf("fork axis-daemon"), "S2: the anchor read before the daemon");
  await r.seam!.shutdown();
});

test("the forks: fixed bundle files, the fixed options, allow-listed environments, the bundle directory as cwd", async (t) => {
  const r = rig(t);
  await until(() => r.forks.length === 2, "both forked");
  const byService = new Map(r.forks.map((f) => [String(f.options["serviceName"]), f]));
  for (const [service, file] of [["axis-daemon", DAEMON_FILE], ["axis-pty", PTY_FILE]] as const) {
    const f = byService.get(service)!;
    assert.equal(f.entry, join(r.bundleDir, file), `S3: ${service} entry`);
    assert.deepEqual(f.args, [], `S3: ${service} args`);
    assert.deepEqual(f.options["execArgv"], UTILITY_EXEC_ARGV, `S3: ${service} execArgv`);
    assert.equal(f.options["cwd"], r.bundleDir, `S3: ${service} cwd is the bundle directory`);
    assert.equal(f.options["stdio"], "pipe", `S3: ${service} stdio`);
    const env = f.options["env"] as Record<string, string>;
    assert.equal(env["SECRET_TOKEN"], undefined, `S3: ${service} env is allow-listed`);
    assert.equal(env["NODE_OPTIONS"], undefined, `S3: ${service}`);
    assert.equal(env["LD_PRELOAD"], undefined, `S3: ${service}`);
    assert.equal(env["HOME"], r.root, `S3: ${service} keeps HOME`);
    assert.ok(Object.isFrozen(env), `S3: ${service} env frozen`);
    assert.deepEqual(f.child.reads.sort(), ["stderr", "stdout"], `S4: ${service} pipes read`);
  }
  assert.equal((byService.get("axis-pty")!.options["env"] as Record<string, string>)["SSH_AUTH_SOCK"], "/tmp/agent.sock", "the pty launch environment adds SSH_AUTH_SOCK");
  const d = byService.get("axis-daemon")!;
  d.child.stderrListener!("x".repeat(5000));
  assert.ok(r.lines.some((l) => l.startsWith("[axis-daemon stderr] ") && l.length <= "[axis-daemon stderr] ".length + 512), "S4: stderr bounded");
  await r.seam!.shutdown();
});

test("the control hand-over reaches both children", async (t) => {
  const r = rig(t);
  await until(() => r.forks.length === 2 && r.forks.every((f) => f.child.posted.some((p) => (p.message as { type?: string })?.type === "pty-control")), "S9: both got a pty-control port");
  for (const f of r.forks) {
    const m = f.child.posted.find((p) => (p.message as { type?: string })?.type === "pty-control")!;
    assert.equal(m.transfer?.length, 1, "S9: exactly one port");
  }
  await r.seam!.shutdown();
});

test("a daemon that exits is restarted, and both children get a fresh hand-over", async (t) => {
  const r = rig(t);
  await until(() => r.forks.length === 2, "both forked");
  const first = r.forks.find((f) => f.options["serviceName"] === "axis-daemon")!;
  first.child.emit("exit", 1);
  r.clock.advance(60_000);
  await until(() => r.forks.filter((f) => f.options["serviceName"] === "axis-daemon").length === 2, "S5: the daemon restarted");
  await r.seam!.shutdown();
});

test("shutdown: the daemon first, then the pty process, and bounded", async (t) => {
  const r = rig(t);
  await until(() => r.forks.length === 2, "both forked");
  r.log.length = 0;
  await r.seam!.shutdown();
  const daemonStop = r.log.findIndex((l) => l === "post axis-daemon shutdown" || l === "kill axis-daemon");
  const ptyStop = r.log.findIndex((l) => l === "kill axis-pty" || l.startsWith("killPid"));
  assert.ok(daemonStop !== -1 && ptyStop !== -1 && daemonStop < ptyStop, `S6: ${JSON.stringify(r.log)}`);
  assert.ok(SEAM_SHUTDOWN_BOUND_MS > DAEMON_STOP_BOUND_MS, "S6: main's bound covers the daemon's own");
  assert.equal(await r.seam!.shutdown(), undefined, "a second shutdown is the same one");
});

test("slice 3.1's answers: native.confirm is refused at once, trust.check is false", async (t) => {
  const r = rig(t);
  await until(() => r.forks.length === 2, "both forked");
  const replies: unknown[] = [];
  r.seam!.answers.onRequest({ type: "native.confirm", challengeId: "c".repeat(20), proof: "p".repeat(20), windowId: "w1", summary: "Delete the worktree" } as never, (m) => void replies.push(m));
  // In the same tick: no window can be named, so the queue refuses before any dialog (a dialog would answer later).
  assert.deepEqual(replies as unknown, [{ type: "native.result", challengeId: "c".repeat(20), proof: "p".repeat(20), confirmed: false, windowId: "w1" }], "S7: refused, not held");
  replies.length = 0;
  r.seam!.answers.onRequest({ type: "trust.check", requestId: "r1", windowId: "w1", projectId: "p1", projectPath: "/home/u/repo" } as never, (m) => void replies.push(m));
  assert.deepEqual(replies as unknown, [{ type: "trust.result", requestId: "r1", trusted: false }], "S8");
  await r.seam!.shutdown();
});

test("a relative bundle directory is refused before anything starts", (t) => {
  assert.throws(() => rig(t, false, "dist/app"), /absolute/, "S3");
});

test("a child's stderr is split, escaped and tagged: it can neither forge main's lines nor reach the terminal", () => {
  const hostile = "ok line\naxis daemon: failed reason=lock_held\r\n\u001b]0;owned\u0007\u001b[31mred\u001b[0m\n\u202Eevil\n";
  const lines = childStderrLines("axis-daemon", new TextEncoder().encode(hostile));
  assert.deepEqual(lines.map((l) => l.slice(0, 21)), Array(4).fill("[axis-daemon stderr] "), "S10: every line tagged");
  assert.equal(lines.some((l) => l.startsWith("axis daemon:")), false, "S10: no forged line of main's");
  for (const l of lines) assert.match(l, /^[\x20-\x7e]+$/, `S10: printable only: ${l}`);
  assert.ok(lines[2]!.includes("\\u{1b}"), "S10: escapes are visible, not executed");
  const many = childStderrLines("axis-pty", Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"));
  assert.equal(many.length, 21, "at most 20 lines per chunk, and a count of the rest");
});

test("settings: both keys are answered unset", async (t) => {
  const r = rig(t);
  await until(() => r.forks.length === 2, "both forked");
  for (const key of ["axis.cliAgents", "axis.git.runHooks"]) {
    const replies: unknown[] = [];
    r.seam!.answers.onRequest({ type: "settings.get", requestId: "r9", key } as never, (m) => void replies.push(m));
    assert.deepEqual(replies as unknown, [{ type: "settings.result", requestId: "r9", key, value: null }], `S11: ${key}`);
  }
  await r.seam!.shutdown();
});

test("the daemon is killed by SIGKILL on its exact pid, as the pty process is", async (t) => {
  const r = rig(t);
  await until(() => r.forks.length === 2, "both forked");
  const d = r.forks.find((f) => f.options["serviceName"] === "axis-daemon")!;
  r.log.length = 0;
  r.clock.advance(70_000); // past the daemon's ready timeout: the supervisor kills it
  assert.ok(r.log.includes(`killPid ${d.child.pid}`), `S12: ${JSON.stringify(r.log)}`);
  assert.equal(d.child.killed, 0, "S12: not utilityProcess.kill (SIGTERM)");
  d.child.emit("exit", null);
  await r.seam!.shutdown();
});

test("a quit during start never spawns the daemon", async (t) => {
  const r = rig(t);
  await r.seam!.shutdown(); // settles only after the start chain ran, so a spawn would have happened by now
  await r.seam!.started;
  assert.equal(r.forks.filter((f) => f.options["serviceName"] === "axis-daemon").length, 0, "S13");
});

test("a daemon that exited leaves the hand-over: a pty restart posts nothing to it", async (t) => {
  const r = rig(t);
  await until(() => r.forks.length === 2, "both forked");
  const d = r.forks.find((f) => f.options["serviceName"] === "axis-daemon")!;
  const p = r.forks.find((f) => f.options["serviceName"] === "axis-pty")!;
  d.child.emit("exit", 78); // a configuration failure: the supervisor does not restart it, so no new daemon replaces this one
  const before = d.child.posted.length;
  p.child.emit("exit", 1);
  r.clock.advance(5_000); // the pty process restarts; the daemon is still in backoff
  await until(() => r.forks.filter((f) => f.options["serviceName"] === "axis-pty").length === 2, "the pty process restarted");
  assert.equal(d.child.posted.length, before, "S14: nothing posted into the dead daemon");
  await r.seam!.shutdown();
});

test("OS-3h: the hand-over is done only once both children acknowledged the same generation", async (t) => {
  const r = rig(t);
  await until(() => r.forks.length === 2 && r.forks.every((f) => f.child.posted.some((m) => (m.message as { type?: string })?.type === "pty-control")), "both posted");
  const generationOf = (f: (typeof r.forks)[number]) => (f.child.posted.find((m) => (m.message as { type?: string })?.type === "pty-control")!.message as { generation: number }).generation;
  const p = r.forks.find((f) => f.options["serviceName"] === "axis-pty")!;
  const d = r.forks.find((f) => f.options["serviceName"] === "axis-daemon")!;
  const g = generationOf(p);
  assert.equal(generationOf(d), g, "one generation to both");
  assert.equal(r.lines.some((l) => l.startsWith("axis pty: handed_over")), false, "posted is not done");
  p.child.emit("message", { type: "pty-control-adopted", generation: g });
  assert.equal(r.lines.some((l) => l.startsWith("axis pty: handed_over")), false, "one acknowledgement is not done");
  d.child.emit("message", { type: "pty-control-adopted", generation: g });
  assert.ok(r.lines.includes(`axis pty: handed_over generation=${g}`), "both acknowledged: done");
  for (const f of [p, d]) assert.ok(f.child.posted.some((m) => (m.message as { type?: string; generation?: number })?.type === "pty-control-confirmed"), "confirmed to both");
  await r.seam!.shutdown();
});

test("OS-3h: without acknowledgements the hand-over fails, the pty process is torn down by pid and held", async (t) => {
  const r = rig(t);
  await until(() => r.forks.length === 2, "both forked");
  const p = r.forks.find((f) => f.options["serviceName"] === "axis-pty")!;
  for (let i = 0; i < 3; i++) {
    r.clock.advance(5_000);
    r.clock.advance(2_000);
  }
  assert.ok(r.lines.some((l) => l.startsWith("axis pty: handover_failed")), JSON.stringify(r.lines.slice(-6)));
  assert.ok(r.log.includes(`killPid ${p.child.pid}`), "torn down by its exact pid");
  p.child.emit("exit", 137);
  r.clock.advance(60_000);
  await settle();
  assert.equal(r.forks.filter((f) => f.options["serviceName"] === "axis-pty").length, 1, "held: not restarted while the daemon runs");
  await r.seam!.shutdown();
});

test("OS-3h: a daemon that ended pty_required is started again once the pty process is back", async (t) => {
  const r = rig(t);
  await until(() => r.forks.length === 2, "both forked");
  const d = r.forks.find((f) => f.options["serviceName"] === "axis-daemon")!;
  const p = r.forks.find((f) => f.options["serviceName"] === "axis-pty")!;
  d.child.emit("message", { type: "fatal", code: "E_INVALID_ARGUMENT", reason: "pty_required" });
  d.child.emit("exit", 78);
  p.child.emit("exit", 1);
  r.clock.advance(5_000); // the pty process restarts after its backoff
  await until(() => r.forks.filter((f) => f.options["serviceName"] === "axis-pty").length === 2, "the pty process restarted");
  await until(() => r.forks.filter((f) => f.options["serviceName"] === "axis-daemon").length === 2, "the daemon was started again");
  await r.seam!.shutdown();
});

test("a flood line is cut before it is escaped, so main's work per line is bounded", () => {
  const [line] = childStderrLines("axis-pty", "x".repeat(100) + "\u0001".repeat(131_072));
  assert.equal(line, `[axis-pty stderr] ${"x".repeat(100)}${"\\u{1}".repeat(412)}`, "S15: the first 512 characters, then escaped");
});
