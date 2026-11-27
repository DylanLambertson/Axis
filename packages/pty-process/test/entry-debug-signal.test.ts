// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Audit C M1 for the pty process: forked with `--disable-sigusr1` (the one accepted execArgv), a SIGUSR1 at 5 ms or 300 ms after
// the fork opens no inspector; without the flag, the entry's listener keeps it closed once the entry runs. Detected by Node's
// stderr line and by a TCP connect to 9229 (skipped when the port is already taken). Not on Windows (RR-83).
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEBUG_SIGNAL_LINE } from "../src/index.js";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "entry-debug-signal-child.js");
const until = async (pred: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
};

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
const NO_SIGUSR1 = process.platform === "win32" ? "no SIGUSR1 on Windows (process._debugProcess: RR-83)" : false;

test("forked with --disable-sigusr1, a pty child signalled at 5 ms and 300 ms opens no inspector and runs", { skip: NO_SIGUSR1 }, async () => {
  const portTaken = await inspectorPortOpen();
  const child = fork(CHILD, [], { env: { PATH: process.env["PATH"] ?? "" }, execArgv: ["--disable-sigusr1"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let err = "";
  child.stderr?.on("data", (c: Buffer) => void (err += c.toString("utf8")));
  try {
    const signal = (): void => {
      try {
        process.kill(child.pid as number, "SIGUSR1");
      } catch {
        // already gone (see below)
      }
    };
    await new Promise((r) => setTimeout(r, 5));
    signal();
    await new Promise((r) => setTimeout(r, 295));
    signal();
    await until(() => err.includes("ready\n") || child.exitCode !== null || child.signalCode !== null);
    await new Promise((r) => setTimeout(r, 300));
    assert.doesNotMatch(err, /Debugger listening|Starting inspector|refused to start/, "no inspector, no refusal");
    if (!portTaken) assert.equal(await inspectorPortOpen(), false, "nothing listens on 9229");
    // A signal in Node's first milliseconds takes the default action (the process ends): a kill, never an inspector.
    if (child.signalCode !== null) assert.equal(child.signalCode, "SIGUSR1", err);
    else {
      assert.ok(err.includes("ready\n"), `the entry ran and did not refuse the flag\n${err}`);
      assert.equal(child.exitCode, null, "the process is still running");
    }
  } finally {
    child.kill("SIGKILL");
  }
});

test("forked without the flag, a pty child sent SIGUSR1 once the entry ran opens no inspector and logs the closed line", { skip: NO_SIGUSR1 }, async () => {
  const child = fork(CHILD, [], { env: { PATH: process.env["PATH"] ?? "" }, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let err = "";
  child.stderr?.on("data", (c: Buffer) => void (err += c.toString("utf8")));
  try {
    await until(() => err.includes("ready\n"));
    assert.ok(err.includes("ready\n"), err);
    process.kill(child.pid as number, "SIGUSR1");
    await until(() => err.includes(DEBUG_SIGNAL_LINE));
    assert.ok(err.includes(DEBUG_SIGNAL_LINE), `the signal reached the entry's listener\n${err}`);
    await new Promise((r) => setTimeout(r, 500));
    assert.doesNotMatch(err, /Debugger listening|Starting inspector/, "no inspector was started");
    assert.equal(child.exitCode, null, "the process is still running");
  } finally {
    child.kill("SIGKILL");
  }
});
