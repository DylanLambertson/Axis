// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-X1b finding: a composed daemon (init + pty-control, `ready`) must end its process soon after `shutdown`, not wait for the
// supervisor's kill (20 s). The child keeps its IPC pipe open until it exits, like an Electron utility process's parent port, so a
// host that only releases and waits to drain stays alive; the entry has to call `process.exit` itself.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT } from "../src/index.js";
import { platformName } from "../testing/entry-harness.js";
import { gitSkipReason } from "../testing/git-fixture.js";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "entry-stop-child.js");
/** Liveness bound only: without the fix the child never exits. Generous for a loaded machine. */
const EXIT_BOUND_MS = 5_000;

test("a composed daemon ends its own process with code 0 after `shutdown`, with the parent channel still open", { skip: gitSkipReason() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "axis-entry-stop-"));
  const env: Record<string, string> = { PATH: process.env["PATH"] ?? "", HOME: root };
  const child = fork(CHILD, [], { env, cwd: root, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced" });
  let err = "";
  child.stderr?.on("data", (c: Buffer) => void (err += c.toString("utf8")));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const posted: string[] = [];
  let stopSent = false;
  child.on("message", (m: Record<string, unknown>) => {
    posted.push(String(m["type"]));
    if (m["type"] === "anchor.get") child.send({ type: "anchor.result", requestId: m["requestId"], anchor: null });
    if (m["type"] === "anchor.put") child.send({ type: "anchor.ack", seq: m["seq"] });
    if (m["type"] === "ready" && !stopSent) {
      stopSent = true;
      child.send({ type: "shutdown" }); // the parent does NOT disconnect: Electron main never closes the parent port
    }
  });
  let killer: NodeJS.Timeout | undefined;
  try {
    const key = randomBytes(32).toString("base64url");
    child.send({ type: "init", config: { dataDir: join(root, "data"), worktreeRoot: join(root, "worktrees"), platform: platformName(), attestationKey: key } });
    const ready = new Promise<void>((resolve) => {
      const check = (m: Record<string, unknown>): void => {
        if (m["type"] === "ready") resolve();
      };
      child.on("message", check);
    });
    await Promise.race([ready, exited]);
    assert.ok(stopSent, `the composed host became ready (posted: ${posted.join(",")})\n${err}`);
    const bound = new Promise<"alive">((resolve) => void (killer = setTimeout(() => resolve("alive"), EXIT_BOUND_MS)));
    const outcome = await Promise.race([exited, bound]);
    assert.notEqual(outcome, "alive", `the daemon was still running ${EXIT_BOUND_MS} ms after shutdown\n${err}`);
    assert.deepEqual(outcome, { code: EXIT.OK, signal: null }, err);
    assert.match(err, /"event":"host\.shutdown","reason":"control:shutdown"/);
    assert.match(err, /^finished 0$/m, "the entry decided the exit code before the process ended");
    assert.equal(err.includes(key), false, "the key reached no log line");
  } finally {
    if (killer !== undefined) clearTimeout(killer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
});
