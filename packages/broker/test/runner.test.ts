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
const waitDead = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 50; i++) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
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
  const runner = createCommandRunner({ killGraceMs: 200 });
  const r = await runner.run(base("setInterval(()=>{},1000)", { timeoutMs: 300 }));
  assert.equal(r.endedBy, "timeout");
  assert.equal(r.killed, true);
  assert.ok(r.durationMs >= 250 && r.durationMs < 5000, String(r.durationMs));
  assert.equal(runner.active, 0);
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
    const r1 = await runner.run({ ...base("", { timeoutMs: 600 }), argv: [node, fixture, pidFile, "hang"] });
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
  const first = runner.run(base("setTimeout(()=>{},700)"));
  await assert.rejects(runner.run(base("0")), (e: unknown) => e instanceof BrokerError && e.code === "E_BACKPRESSURE");
  assert.equal(runner.active, 1);
  await first;
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
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(runner.killAll(), 1);
  const r = await p;
  assert.ok(r.signal !== null || !posix);
  assert.equal(runner.active, 0);
  const timers = process.getActiveResourcesInfo().filter((x) => x === "Timeout");
  assert.equal(timers.length, 0, "no timer survives a finished run");
});
