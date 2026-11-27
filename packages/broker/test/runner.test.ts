// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrokerError, createCommandRunner, type CommandSpec } from "../src/index.js";

const node = process.execPath;
const posix = process.platform !== "win32";
const base = (script: string, extra: Partial<CommandSpec> = {}): CommandSpec => ({
  argv: [node, "-e", script], cwd: tmpdir(), env: { PATH: process.env["PATH"] ?? "" }, timeoutMs: 10_000, maxOutputBytes: 1 << 20, ...extra,
});
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Wait by condition (30 s bound, only so a stuck test fails by name instead of hanging). */
const waitFor = async (pred: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 30_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`condition not reached: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** Wait by condition for a process to be gone; the 30 s bound only turns a process that never dies into a failure. */
const waitDead = async (pid: number): Promise<boolean> => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

test("a normal run records exit, output and no kill", async () => {
  const r = await createCommandRunner().run(base('process.stdout.write("out");process.stderr.write("err");process.exit(3)'));
  assert.equal(r.endedBy, "exit");
  assert.equal(r.exitCode, 3);
  assert.equal(r.stdout.toString(), "out");
  assert.equal(r.stderr.toString(), "err");
  assert.equal(r.killed, false);
  assert.equal(r.strayKilled, false);
});

test("timeout kills the process and records why", async () => {
  // The grace is a hang guard only: a child that dies on SIGTERM is reaped by its exit event, which a loaded host can deliver late. With a
  // short grace the runner gave up on it (`unkillable`, slot still held) and `active` read 1.
  const runner = createCommandRunner({ killGraceMs: 10_000 });
  const r = await runner.run(base("setInterval(()=>{},1000)", { timeoutMs: 300 }));
  assert.equal(r.endedBy, "timeout");
  assert.equal(r.killed, true);
  assert.equal(r.unkillable, false);
  assert.ok(r.durationMs >= 250 && r.durationMs < 30_000, String(r.durationMs)); // a timer never fires early; the upper bound only catches a kill that never happens
  assert.equal(runner.active, 0);
});

test("with the production default grace, a process that ignores SIGTERM is killed and its slot released", { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "axis-run-"));
  let childPid: number | undefined;
  try {
    const ready = join(dir, "ready");
    const abort = new AbortController();
    const runner = createCommandRunner();
    // Aborted only once the child has installed its SIGTERM handler (it says so by a file), so the kill cannot beat the handler on a loaded host.
    const script = `process.on("SIGTERM",()=>{});require("fs").writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`;
    const run = runner.run(base(script, { signal: abort.signal }));
    await waitFor(() => existsSync(ready) && readFileSync(ready, "utf8") !== "", "the child's handler is installed");
    childPid = Number(readFileSync(ready, "utf8"));
    abort.abort();
    const r = await run;
    assert.equal(r.endedBy, "aborted");
    assert.equal(r.killed, true);
    assert.equal(r.signal, "SIGKILL", "the default grace ended in a kill, not in giving up");
    assert.equal(r.unkillable, false);
    assert.equal(runner.active, 0);
  } finally {
    // A regression that stops the SIGKILL must fail this test, not leave a SIGTERM-ignoring child holding the test run open.
    if (childPid !== undefined) try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("output cap kills the process, keeps exactly the cap and flags truncation", async () => {
  const r = await createCommandRunner({ killGraceMs: 200 }).run(base('setInterval(()=>process.stdout.write("x".repeat(4096)),1)', { maxOutputBytes: 10_000 }));
  assert.equal(r.endedBy, "output-cap");
  assert.equal(r.truncated, true);
  assert.equal(r.stdout.length + r.stderr.length, 10_000);
});

test("a grandchild in the group dies with a timeout, and a stray after a clean exit is killed", { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "axis-run-"));
  try {
    const pidFile = join(dir, "pid");
    const fixture = fileURLToPath(new URL("../../test/fixtures/spawner.mjs", import.meta.url));
    const runner = createCommandRunner({ killGraceMs: 200 });
    // The timeout must outlast the fixture's start on a loaded host: it kills the group, and the pid file is written only after the fixture started its grandchild.
    const r1 = await runner.run({ ...base("", { timeoutMs: 6000 }), argv: [node, fixture, pidFile, "hang"] });
    assert.equal(r1.endedBy, "timeout");
    const pid1 = Number(readFileSync(pidFile, "utf8"));
    assert.ok(await waitDead(pid1), "the grandchild was killed with the group");
    rmSync(pidFile);
    const r2 = await runner.run({ ...base(""), argv: [node, fixture, pidFile, "exit"] });
    assert.equal(r2.endedBy, "exit");
    assert.equal(r2.strayKilled, true, "the child that outlived its parent was killed");
    assert.ok(await waitDead(Number(readFileSync(pidFile, "utf8"))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a signal and a spawn error are recorded", async () => {
  const runner = createCommandRunner();
  const r = await runner.run(base('process.kill(process.pid,"SIGKILL")'));
  assert.equal(r.endedBy, posix ? "signal" : "exit");
  const missing = await runner.run({ ...base(""), argv: [join(tmpdir(), "no-such-binary-axis")] });
  assert.equal(missing.endedBy, "spawn-error");
  assert.equal(missing.errorCode, "ENOENT");
  assert.equal(runner.active, 0);
});

test("abort: before the run no process starts, during the run it is killed", async () => {
  const runner = createCommandRunner({ killGraceMs: 200 });
  const pre = new AbortController();
  pre.abort();
  const a = await runner.run(base("process.exit(0)", { signal: pre.signal }));
  assert.equal(a.endedBy, "aborted");
  assert.equal(a.exitCode, null, "never started");
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const b = await runner.run(base("setInterval(()=>{},1000)", { signal: ac.signal }));
  assert.equal(b.endedBy, "aborted");
});

test("no shell: metacharacters in argv stay literal; stdin is delivered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "axis-run-"));
  try {
    const marker = join(dir, "pwned");
    const r = await createCommandRunner().run({ ...base(""), argv: [node, "-e", "process.stdout.write(process.argv[1])", `$(touch ${marker}); \`id\` | tee`] });
    assert.ok(r.stdout.toString().startsWith("$(touch "));
    assert.equal(existsSync(marker), false);
    const s = await createCommandRunner().run(base('process.stdin.pipe(process.stdout)', { stdin: Buffer.from("piped") }));
    assert.equal(s.stdout.toString(), "piped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the slot is held while a process runs and released after; extra runs get E_BACKPRESSURE", async () => {
  const runner = createCommandRunner({ maxConcurrent: 1, killGraceMs: 200 });
  // The first run holds the slot until the test aborts it: no delay decides whether the second run finds the slot taken.
  const hold = new AbortController();
  const first = runner.run(base("setInterval(()=>{},1000)", { signal: hold.signal }));
  try {
    await assert.rejects(runner.run(base("0")), (e: unknown) => e instanceof BrokerError && e.code === "E_BACKPRESSURE");
    assert.equal(runner.active, 1);
  } finally {
    hold.abort();
  }
  assert.equal((await first).endedBy, "aborted");
  // The slot is held until the process has exited, which can be after the run's promise settled: wait for it by condition.
  await waitFor(() => runner.active === 0, "the run released its slot");
  assert.equal(runner.active, 0);
  assert.equal((await runner.run(base("0"))).endedBy, "exit");
});

test("invalid specs are refused: NaN and fractional limits, relative argv0, NUL, bad env, shell strings", async () => {
  const runner = createCommandRunner();
  const bad: Array<Partial<CommandSpec>> = [
    { timeoutMs: NaN }, { timeoutMs: Infinity }, { timeoutMs: 0 }, { timeoutMs: 1.5 }, { timeoutMs: 10 ** 9 },
    { maxOutputBytes: NaN }, { maxOutputBytes: 0 }, { maxOutputBytes: 2 ** 40 },
    { argv: [] }, { argv: ["node", "-e", "1"] }, { argv: [node, "a\0b"] }, { argv: [node, 5 as never] },
    { cwd: "relative" }, { env: { A: 1 } as never }, { env: { "A=B": "x" } }, { stdin: "text" as never },
  ];
  for (const b of bad) {
    await assert.rejects(runner.run({ ...base("0"), ...b }), (e: unknown) => e instanceof BrokerError && e.code === "E_INVALID_ARGUMENT", JSON.stringify(b));
  }
  assert.throws(() => createCommandRunner({ maxConcurrent: NaN }));
  assert.throws(() => createCommandRunner({ killGraceMs: -1 }));
});

test("killAll kills live groups and leaves no timers behind", async () => {
  const runner = createCommandRunner({ killGraceMs: 200 });
  const p = runner.run(base("setInterval(()=>{},1000)"));
  await waitFor(() => runner.active === 1, "the run is active");
  assert.equal(runner.killAll(), 1);
  const r = await p;
  assert.ok(r.signal !== null || !posix);
  assert.equal(runner.active, 0);
  const timers = process.getActiveResourcesInfo().filter((x) => x === "Timeout");
  assert.equal(timers.length, 0, "no timer survives a finished run");
});
