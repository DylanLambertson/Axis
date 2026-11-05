// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { test } from "node:test";
import { wait } from "./helpers.js";

/**
 * Exit by draining (design section 8): a real host in a child process, signalled while work is pending. The child
 * never calls `process.exit` after a released shutdown, so it ends only when no timer, listener, handle or lock
 * keeps the event loop alive.
 */
const CHILD = new URL("../testing/lifecycle-child.js", import.meta.url);

interface Child {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly out: Array<Record<string, unknown>>;
  readonly closed: Promise<number | null>;
  send(line: string): Promise<void>;
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await wait(10);
  return cond();
}

async function start(finalizeMs = 30_000): Promise<Child> {
  const proc = spawn(process.execPath, [CHILD.pathname, String(finalizeMs)], { stdio: ["pipe", "pipe", "pipe"] });
  const out: Array<Record<string, unknown>> = [];
  let buf = "";
  proc.stdout.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      out.push(JSON.parse(buf.slice(0, i)) as Record<string, unknown>);
      buf = buf.slice(i + 1);
    }
  });
  proc.stderr.on("data", () => undefined);
  const closed = new Promise<number | null>((resolve) => proc.on("close", (code) => resolve(code)));
  const child: Child = {
    proc,
    out,
    closed,
    async send(line) {
      const n = out.filter((o) => o["ack"] === line).length;
      proc.stdin.write(`${line}\n`);
      assert.ok(await until(() => out.filter((o) => o["ack"] === line).length > n || proc.exitCode !== null, 3000), `child acknowledged ${line}`);
    },
  };
  assert.ok(await until(() => out.some((o) => o["ready"] === true), 15_000), "child became ready");
  return child;
}

for (const trigger of process.platform === "win32" ? (["message"] as const) : (["signal", "message"] as const)) {
  test(`exit by draining: after ${trigger} the process ends only once pending work has drained, then on its own within 2 s`, async (t) => {
    const c = await start();
    t.after(() => void c.proc.kill("SIGKILL"));
    await c.send("pending");
    await c.send(trigger);
    // Shutdown has begun and must be waiting for the work: no exit report and a live process.
    await wait(300);
    assert.equal(c.out.some((o) => "exit" in o), false, "no exit while work is pending");
    assert.equal(c.proc.exitCode, null, "still alive while work is pending");
    c.proc.stdin.write("release\n");
    assert.ok(await until(() => c.out.some((o) => "exit" in o), 3000), "the exit hook ran after the drain");
    const report = c.out.find((o) => "exit" in o);
    assert.deepEqual([report?.["exit"], report?.["released"], report?.["running"]], [0, true, 0]);
    const started = Date.now();
    const code = await Promise.race([c.closed, wait(2000).then(() => "timeout" as const)]);
    assert.equal(code, 0, "exited by draining with code 0 (a leaked timer, listener or handle would hold it past 2 s)");
    assert.ok(Date.now() - started < 2000);
  });
}

test("a repeated trigger while work is still running ends the wait: exit 1, the store is not released, the caller forces the exit", async (t) => {
  const c = await start();
  t.after(() => void c.proc.kill("SIGKILL"));
  await c.send("pending");
  await c.send("message");
  await wait(100);
  await c.send("again");
  assert.ok(await until(() => c.out.some((o) => "exit" in o), 3000), "escalation cut the grace wait short");
  const report = c.out.find((o) => "exit" in o);
  assert.deepEqual([report?.["exit"], report?.["released"], report?.["running"]], [1, false, 1]);
  assert.equal(await c.closed, 1);
});
