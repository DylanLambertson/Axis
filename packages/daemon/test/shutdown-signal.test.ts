// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { installShutdownSignals, type ShutdownResult } from "../src/index.js";

const result = (over: Partial<ShutdownResult> = {}): ShutdownResult => ({
  reason: "x",
  graceful: true,
  escalated: false,
  cancelled: 0,
  unsettled: 0,
  flushed: "unsupported",
  ...over,
});

function fake(res: ShutdownResult = result()) {
  const calls = { shutdown: [] as string[], escalate: 0 };
  let finish!: (r: ShutdownResult) => void;
  const pending = new Promise<ShutdownResult>((r) => (finish = r));
  return {
    calls,
    finish: () => finish(res),
    daemon: {
      shutdown(reason: string) {
        calls.shutdown.push(reason);
        return pending;
      },
      escalate() {
        calls.escalate++;
      },
    },
  };
}
const tick = () => new Promise((r) => setImmediate(r));

test("first signal shuts down, the second escalates, later ones are ignored, listeners are removed at the end", async () => {
  const src = new EventEmitter();
  const f = fake();
  const codes: number[] = [];
  installShutdownSignals(f.daemon, { source: src, exit: (c) => void codes.push(c) });
  assert.equal(src.listenerCount("SIGTERM"), 1);
  assert.equal(src.listenerCount("SIGINT"), 1);
  src.emit("SIGTERM", "SIGTERM");
  src.emit("SIGINT", "SIGINT");
  src.emit("SIGTERM", "SIGTERM");
  assert.deepEqual(f.calls.shutdown, ["signal:SIGTERM"]);
  assert.equal(f.calls.escalate, 2);
  f.finish();
  await tick();
  assert.deepEqual(codes, [0]);
  assert.equal(src.listenerCount("SIGTERM"), 0);
  assert.equal(src.listenerCount("SIGINT"), 0);
});

test("exit code is 1 when handlers were cancelled or are still running; a throwing exit hook does not reject", async () => {
  for (const res of [result({ graceful: false, cancelled: 1 }), result({ unsettled: 2 })]) {
    const src = new EventEmitter();
    const f = fake(res);
    const codes: number[] = [];
    installShutdownSignals(f.daemon, {
      source: src,
      exit: (c) => {
        codes.push(c);
        throw new Error("exit hook failed");
      },
    });
    src.emit("SIGTERM", "SIGTERM");
    f.finish();
    await tick();
    assert.deepEqual(codes, [1]);
  }
});

test("a shutdown that rejects still exits (code 1) and dispose is idempotent", async () => {
  const src = new EventEmitter();
  const codes: number[] = [];
  const h = installShutdownSignals(
    { shutdown: () => Promise.reject(new Error("boom")), escalate: () => undefined },
    { source: src, signals: ["SIGTERM"], exit: (c) => void codes.push(c) },
  );
  src.emit("SIGTERM", "SIGTERM");
  await tick();
  assert.deepEqual(codes, [1]);
  h.dispose();
  h.dispose();
  assert.equal(src.listenerCount("SIGTERM"), 0);
});

test("dispose before any signal removes the listeners", () => {
  const src = new EventEmitter();
  const h = installShutdownSignals(fake().daemon, { source: src, exit: () => undefined });
  h.dispose();
  assert.equal(src.listenerCount("SIGTERM") + src.listenerCount("SIGINT"), 0);
});

// A real signal needs a POSIX kill; Windows terminates the process without running handlers.
test("a real SIGTERM lets the in-flight request finish, then the child exits 0 on its own", { skip: process.platform === "win32", timeout: 20_000 }, async (t) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./shutdown-child.js", import.meta.url))], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill("SIGKILL"));
  let out = "";
  let started!: () => void;
  const startedP = new Promise<void>((r) => (started = r));
  child.stdout.on("data", (d: Buffer) => {
    out += d.toString();
    if (out.includes("started\n")) started();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.on("exit", (code, signal) => r({ code, signal })));
  await startedP;
  child.kill("SIGTERM");
  const { code, signal } = await exited;
  assert.equal(signal, null, "the child must handle the signal, not die from it");
  assert.equal(code, 0);
  const last = out.trim().split("\n").at(-1) ?? "";
  assert.deepEqual(JSON.parse(last), { code: 0, answered: true, ok: true });
});
