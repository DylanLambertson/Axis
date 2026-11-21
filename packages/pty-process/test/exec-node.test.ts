// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PV-X1a: the production exec function over real processes. The program is this Node binary (it adds nothing to its environment),
// started with `-e`; POSIX only (Windows refuses before anything starts, tested without a process).
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createNodeExec, ExecStartError, type ExecOutcome, type ExecRequest } from "../src/index.js";

const NODE = process.execPath;
const POSIX = process.platform === "win32" ? "POSIX process groups" : false;

function scratch(t: TestContext): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "axis-exec-node-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/**
 * Every test program ends itself after 8 s (an unref'd timer: a program that finishes sooner is not held). So a broken exec function
 * (stdin never ended, no group to kill) fails an assertion within seconds and leaves no process to keep this file running.
 */
const GUARD = "setTimeout(()=>process.exit(97),8000).unref();";
const req = (cwd: string, code: string, extra: Partial<ExecRequest> = {}): ExecRequest => ({ argv: [NODE, "-e", GUARD + code], cwd, env: { AXIS_T: "1" }, maxOutput: 1024 * 1024, ...extra });
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof ExecStartError ? e.code : "other";
  }
  return undefined;
};
/** True while a process with this pid exists and is not a zombie (Linux reads its state; elsewhere signal 0). */
function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !/^\d+ \(.*\) [ZX] /s.test(stat);
  } catch {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
async function waitFor(what: string, cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("only an exact configured program starts: another path, a relative name, a trailing space, another case, a prefix and dot segments are refused before anything runs", { skip: POSIX }, (t) => {
  const dir = scratch(t);
  const sentinel = join(dir, "ran");
  const prog = join(dir, "Prog");
  writeFileSync(prog, `#!/bin/sh\n: > '${sentinel}'\n`);
  chmodSync(prog, 0o755);
  const exec = createNodeExec(new Set([prog]), process.platform);
  for (const p of [NODE, "Prog", `${prog} `, join(dir, "prog"), prog.slice(0, -1), `${dir}/./Prog`, `${dir}//Prog`, ` ${prog}`, ""]) {
    assert.equal(codeOf(() => exec({ argv: [p], cwd: dir, env: {}, maxOutput: 10 })), "program_refused", JSON.stringify(p));
  }
  assert.equal(codeOf(() => exec({ argv: [], cwd: dir, env: {}, maxOutput: 10 })), "program_refused");
  assert.equal(existsSync(sentinel), false, "nothing ran");
  // A relative or empty member is refused when the function is built.
  assert.equal(codeOf(() => createNodeExec(new Set(["git"]), process.platform)), "program_refused");
  assert.equal(codeOf(() => createNodeExec(new Set([""]), process.platform)), "program_refused");
});

test("the configured program runs with exactly the given environment and cwd, no shell, stdin ended", { skip: POSIX, timeout: 20_000 }, async (t) => {
  const dir = scratch(t);
  process.env["AXIS_CANARY_X1A"] = "planted";
  t.after(() => delete process.env["AXIS_CANARY_X1A"]);
  const exec = createNodeExec(new Set([NODE]), process.platform);
  const env = { AXIS_T: "1", A: "a b;$(x)", EMPTY: "" };
  const r = await exec(req(dir, "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({env:process.env,cwd:process.cwd(),argv:process.argv.slice(1)})))", { env })).done;
  const seen = JSON.parse(Buffer.from(r.stdout).toString("utf8")) as { env: Record<string, string>; cwd: string; argv: string[] };
  assert.deepEqual(seen.env, env, "nothing merged from this process (no canary) and nothing added");
  assert.equal(seen.cwd, dir);
  assert.equal(r.code, 0);
  // With input: written, then ended.
  const echo = await exec(req(dir, "process.stdin.pipe(process.stdout)", { stdin: Buffer.from("in;put") })).done;
  assert.equal(Buffer.from(echo.stdout).toString(), "in;put");
  // An argument is an argument: shell syntax stays literal.
  const lit = await exec({ argv: [NODE, "-e", `${GUARD}process.stdout.write(process.argv[1])`, "$(touch x); `y` | z"], cwd: dir, env: {}, maxOutput: 100 }).done;
  assert.equal(Buffer.from(lit.stdout).toString(), "$(touch x); `y` | z");
  assert.equal(existsSync(join(dir, "x")), false);
});

test("each stream is held up to its own cap and read to the end; the flags say which was cut", { skip: POSIX, timeout: 20_000 }, async (t) => {
  const dir = scratch(t);
  const exec = createNodeExec(new Set([NODE]), process.platform);
  const flood = "const o=Buffer.alloc(5*1024*1024,111),e=Buffer.alloc(1024*1024,101);process.stdout.write(o);process.stderr.write(e);";
  const r: ExecOutcome = await exec(req(dir, flood, { maxOutput: 4 * 1024 * 1024, maxStderr: 64 * 1024 })).done;
  assert.equal(r.code, 0, "the child was not blocked on a full pipe");
  assert.equal(r.stdout.length, 4 * 1024 * 1024);
  assert.equal(r.stderr.length, 64 * 1024);
  assert.deepEqual([r.truncated, r.stdoutTruncated, r.stderrTruncated], [true, true, true]);
  const onlyErr = await exec(req(dir, "process.stdout.write('ok');process.stderr.write(Buffer.alloc(200,101))", { maxOutput: 100, maxStderr: 50 })).done;
  assert.deepEqual([Buffer.from(onlyErr.stdout).toString(), onlyErr.stderr.length, onlyErr.truncated, onlyErr.stdoutTruncated, onlyErr.stderrTruncated], ["ok", 50, true, false, true]);
  const onlyOut = await exec(req(dir, "process.stdout.write(Buffer.alloc(200,111));process.stderr.write('e')", { maxOutput: 50, maxStderr: 100 })).done;
  assert.deepEqual([onlyOut.stdout.length, Buffer.from(onlyOut.stderr).toString(), onlyOut.stdoutTruncated, onlyOut.stderrTruncated], [50, "e", true, false]);
  // Without maxStderr, stderr takes maxOutput.
  const dflt = await exec(req(dir, "process.stderr.write(Buffer.alloc(200,101))", { maxOutput: 30 })).done;
  assert.deepEqual([dflt.stderr.length, dflt.stderrTruncated, dflt.stdoutTruncated], [30, true, false]);
  const exact = await exec(req(dir, "process.stdout.write(Buffer.alloc(30,111))", { maxOutput: 30 })).done;
  assert.deepEqual([exact.stdout.length, exact.truncated], [30, false], "exactly the cap is not a cut");
  for (const bad of [-1, 1.5, Number.NaN]) assert.equal(codeOf(() => exec(req(dir, "", { maxOutput: bad }))), "start_failed", String(bad));
  assert.equal(codeOf(() => exec(req(dir, "", { maxStderr: -1 }))), "start_failed");
});

test("a start that fails after the call rejects done with a closed code and no path", { skip: POSIX, timeout: 20_000 }, async (t) => {
  const dir = scratch(t);
  const missing = join(dir, "missing-program");
  const plain = join(dir, "plain-file");
  writeFileSync(plain, "not a program\n");
  chmodSync(plain, 0o644);
  const exec = createNodeExec(new Set([missing, plain]), process.platform);
  for (const [p, want] of [[missing, "not_found"], [plain, "not_permitted"]] as const) {
    await assert.rejects(exec({ argv: [p], cwd: dir, env: {}, maxOutput: 10 }).done, (e: unknown) => e instanceof ExecStartError && e.code === want && !e.message.includes(dir), p);
  }
  // A missing cwd is a failed start too, never a run elsewhere.
  const node = createNodeExec(new Set([NODE]), process.platform);
  await assert.rejects(node(req(join(dir, "no-such-dir"), "")).done, (e: unknown) => e instanceof ExecStartError && e.code === "not_found");
});

test("kill ends the whole group: a grandchild that ignores SIGTERM and holds the pipes is gone and done settles", { skip: POSIX, timeout: 20_000 }, async (t) => {
  const dir = scratch(t);
  const pidFile = join(dir, "gc.pid");
  const exec = createNodeExec(new Set([NODE]), process.platform);
  const grandchild = `${GUARD}process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
  const leader = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  const child = exec(req(dir, leader));
  await waitFor("the grandchild's pid", () => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "");
  const gc = Number(readFileSync(pidFile, "utf8"));
  assert.ok(running(gc));
  child.kill();
  const r = await child.done;
  assert.equal(r.signal, "SIGKILL");
  await waitFor("the grandchild to be gone", () => !running(gc));
});

test("done settles only after the group is killed: a grandchild that let go of the pipes and kept running dies when the leader exits", { skip: POSIX, timeout: 20_000 }, async (t) => {
  const dir = scratch(t);
  const pidFile = join(dir, "gc.pid");
  const exec = createNodeExec(new Set([NODE]), process.platform);
  const grandchild = `${GUARD}require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
  const leader = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});c.unref();const f=${JSON.stringify(pidFile)};const w=setInterval(()=>{if(require('fs').existsSync(f)){clearInterval(w);process.exit(0)}},10)`;
  const r = await exec(req(dir, leader)).done;
  assert.equal(r.code, 0);
  const gc = Number(readFileSync(pidFile, "utf8"));
  await waitFor("the grandchild to be gone after done settled", () => !running(gc));
});

test("Windows refuses before anything starts (no process group; the job-object kill is PV-X1w)", (t) => {
  const dir = scratch(t);
  const sentinel = join(dir, "ran");
  const exec = createNodeExec(new Set([NODE]), "win32");
  assert.equal(codeOf(() => exec(req(dir, `require('fs').writeFileSync(${JSON.stringify(sentinel)},'x')`))), "unsupported_platform");
  assert.equal(existsSync(sentinel), false);
});
