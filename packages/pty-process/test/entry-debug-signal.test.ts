// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Audit C M1 for the pty process: SIGUSR1 sent to a real child running the entry opens no inspector (Node prints
// "Debugger listening" when it does), and the entry writes its one closed line.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEBUG_SIGNAL_LINE } from "../src/index.js";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "entry-debug-signal-child.js");
const until = async (pred: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
};

test("a real pty entry child sent SIGUSR1 opens no inspector and logs the closed line", { skip: process.platform === "win32" ? "no SIGUSR1 on Windows" : false }, async () => {
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
