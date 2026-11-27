// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Audit C M1: `kill -USR1 <daemon>` makes Node open an unauthenticated inspector on 127.0.0.1:9229, from which any local user
// could read every revealed credential in the heap. The entry refuses inspector flags, `execArgv` and `NODE_OPTIONS`, but a
// signal is not a flag: the entry's own SIGUSR1 listener, installed before anything else and never removed, replaces Node's
// default handler, so the signal opens nothing. Shown on a real child process, and on the fake process for every refusal path.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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

test("a real daemon child sent SIGUSR1 opens no inspector, logs the closed line, and still shuts down cleanly", { skip: process.platform === "win32" ? "no SIGUSR1 on Windows" : gitSkipReason() }, async () => {
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
