// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Audit C M1: `kill -USR1 <daemon>` makes Node open an unauthenticated inspector on 127.0.0.1:9229, from which any local user
// could read every revealed credential in the heap. Here, on plain Node:
// - `--disable-sigusr1`, the one `execArgv` the entry accepts, holds from the first instruction: a signal at 5 ms or 300 ms after
//   the fork, while the module graph is still loading, opens nothing. Electron's utility process ignores the flag, so there
//   the control is the guard the forked file installs before the graph loads (`process-main.test.ts`);
// - the entry's own listener, installed first and never removed, holds once the entry runs, for a fork without the flag.
// Detected by Node's stderr line and by a TCP connect to 9229 (skipped when the port is already taken). Not on Windows, where
// `process._debugProcess(pid)` starts the inspector with no signal and no listener can stop it (RR-83).
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEBUG_SIGNAL_LINE, runDaemonEntry, type DaemonEntryDeps } from "../src/entry.js";
import { FakeProcess, platformName } from "../testing/entry-harness.js";
import { gitSkipReason } from "../testing/git-fixture.js";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "entry-stop-child.js");

test("the entry's first act is a SIGUSR1 listener, kept on every refusal path, that writes one closed line", () => {
  for (const over of [{ parentPort: undefined }, { execArgv: ["--inspect"] }, { execArgv: ["--require=x"] }, { env: { NODE_OPTIONS: "--inspect" } }] as Array<Partial<DaemonEntryDeps>>) {
    const proc = new FakeProcess();
    const lines: string[] = [];
    runDaemonEntry({ parentPort: undefined, process: proc, env: {}, cwd: process.cwd(), platform: platformName(), execArgv: [], stderr: (l) => void lines.push(l), ...over } as DaemonEntryDeps);
    assert.equal(proc.listenerCount("SIGUSR1"), 1, JSON.stringify(over));
    const before = lines.length;
    proc.emit("SIGUSR1");
    proc.emit("SIGUSR1");
    assert.deepEqual(lines.slice(before), [DEBUG_SIGNAL_LINE], "one closed line, however often the signal comes");
  }
});

/** True when something accepts a TCP connection on 127.0.0.1:9229 within 1 s. */
const inspectorPortOpen = (): Promise<boolean> =>
  new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port: 9229 });
    const done = (open: boolean): void => {
      sock.destroy();
      resolve(open);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1_000, () => done(false));
  });

interface Child {
  readonly child: ReturnType<typeof fork>;
  readonly err: () => string;
  readonly ready: Promise<void>;
  readonly exited: Promise<{ code: number | null }>;
}

function startChild(root: string, execArgv: string[]): Child {
  const child = fork(CHILD, [], { env: { PATH: process.env["PATH"] ?? "", HOME: root }, cwd: root, execArgv, stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced" });
  let err = "";
  child.stderr?.on("data", (c: Buffer) => void (err += c.toString("utf8")));
  const exited = new Promise<{ code: number | null }>((resolve) => child.once("exit", (code) => resolve({ code })));
  child.on("message", (m: Record<string, unknown>) => {
    if (m["type"] === "anchor.get") child.send({ type: "anchor.result", requestId: m["requestId"], anchor: null });
    if (m["type"] === "anchor.put") child.send({ type: "anchor.ack", seq: m["seq"] });
  });
  const ready = new Promise<void>((resolve) => child.on("message", (m: Record<string, unknown>) => m["type"] === "ready" && resolve()));
  child.send({ type: "init", config: { dataDir: join(root, "data"), worktreeRoot: join(root, "worktrees"), platform: platformName(), attestationKey: randomBytes(32).toString("base64url") } });
  return { child, err: () => err, ready, exited };
}

const NO_SIGUSR1 = process.platform === "win32" ? "no SIGUSR1 on Windows (process._debugProcess: RR-83)" : gitSkipReason();

test("forked with --disable-sigusr1, a daemon child signalled at 5 ms and 300 ms, while still loading, never opens an inspector", { skip: NO_SIGUSR1 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "axis-entry-usr1-early-"));
  const portTaken = await inspectorPortOpen();
  const c = startChild(root, ["--disable-sigusr1"]);
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  c.child.once("exit", (code, signal) => void (exit = { code, signal }));
  const signal = (): void => {
    try {
      process.kill(c.child.pid as number, "SIGUSR1");
    } catch {
      // already gone (see below)
    }
  };
  try {
    await new Promise((r) => setTimeout(r, 5));
    signal();
    await new Promise((r) => setTimeout(r, 295));
    signal();
    await Promise.race([c.ready, c.exited]);
    assert.doesNotMatch(c.err(), /Debugger listening|Starting inspector/, "no inspector was started");
    if (!portTaken) assert.equal(await inspectorPortOpen(), false, "nothing listens on 9229");
    if (exit !== undefined) {
      // A signal in Node's first milliseconds, before it sets the signal's disposition, takes the default action: the process
      // ends. That is a kill, which a same-UID process can do anyway, never an inspector.
      assert.equal(exit.signal, "SIGUSR1", `the only way the child may end here is the signal's default action\n${c.err()}`);
      return;
    }
    c.child.send({ type: "shutdown" });
    assert.deepEqual(await c.exited, { code: 0 });
  } finally {
    if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("forked without the flag, a daemon child sent SIGUSR1 after ready opens no inspector (the listener), logs the closed line, and shuts down cleanly", { skip: NO_SIGUSR1 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "axis-entry-usr1-"));
  const child = fork(CHILD, [], { env: { PATH: process.env["PATH"] ?? "", HOME: root }, cwd: root, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced" });
  let err = "";
  child.stderr?.on("data", (c: Buffer) => void (err += c.toString("utf8")));
  const exited = new Promise<{ code: number | null }>((resolve) => child.once("exit", (code) => resolve({ code })));
  child.on("message", (m: Record<string, unknown>) => {
    if (m["type"] === "anchor.get") child.send({ type: "anchor.result", requestId: m["requestId"], anchor: null });
    if (m["type"] === "anchor.put") child.send({ type: "anchor.ack", seq: m["seq"] });
  });
  const ready = new Promise<void>((resolve) => child.on("message", (m: Record<string, unknown>) => m["type"] === "ready" && resolve()));
  try {
    child.send({ type: "init", config: { dataDir: join(root, "data"), worktreeRoot: join(root, "worktrees"), platform: platformName(), attestationKey: randomBytes(32).toString("base64url") } });
    await Promise.race([ready, exited.then(() => assert.fail(`the child exited before ready\n${err}`))]);
    process.kill(child.pid as number, "SIGUSR1");
    const deadline = Date.now() + 10_000;
    while (!err.includes(DEBUG_SIGNAL_LINE) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(err.includes(DEBUG_SIGNAL_LINE), `the signal reached the entry's listener\n${err}`);
    // Node prints this line when SIGUSR1 starts the inspector (or "Starting inspector ... failed" when the port is taken).
    await new Promise((r) => setTimeout(r, 500));
    assert.doesNotMatch(err, /Debugger listening|Starting inspector/, "no inspector was started");
    assert.equal(child.exitCode, null, "the daemon is still running");
    child.send({ type: "shutdown" });
    assert.deepEqual(await exited, { code: 0 });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
