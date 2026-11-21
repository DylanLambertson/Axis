// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Smoke test: runs scripts/gate.mjs against a throwaway git repository.
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const gate = fileURLToPath(new URL("../../scripts/gate.mjs", import.meta.url));
const ciYml = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const SKIP_HEAVY = "gitleaks,typecheck,test";

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(cwd, file, content, message) {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", message);
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "axis-gate-smoke-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "commit.gpgsign", "false");
  mkdirSync(join(dir, "code-oss"));
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  copyFileSync(ciYml, join(dir, ".github", "workflows", "ci.yml"));
  writeFileSync(join(dir, "code-oss", "upstream.json"), JSON.stringify({ node: process.version.slice(1) }));
  commit(dir, "README.md", "hello\n", "chore: base");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(dir, "checkout", "-q", "-b", "chore/smoke");
  return dir;
}

/** The caller's environment without GATE_* knobs or git variables that would steer the child. */
function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GATE_") && !k.startsWith("GIT_")));
}

function runGate(cwd, env = {}) {
  const r = spawnSync(process.execPath, [gate], {
    cwd, encoding: "utf8", env: { ...cleanEnv(), GATE_SKIP: SKIP_HEAVY, ...env }
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("a clean change passes every runnable step and reports incomplete for the skipped ones", () => {
  const dir = setup();
  try {
    commit(dir, "a.txt", "one\ntwo\n", "feat: add a file");
    const { code, out } = runGate(dir);
    assert.equal(code, 2, out);
    assert.match(out, /PASS {2}git diff --check/);
    assert.match(out, /PASS {2}commit wording/);
    assert.match(out, /PASS {2}node version/);
    assert.match(out, /SKIP {2}gitleaks/);
    assert.ok(out.includes(`head:   ${git(dir, "rev-parse", "HEAD")}`));
    assert.match(out, /branch: chore\/smoke/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("every failing gate is reported in one run", () => {
  const dir = setup();
  try {
    commit(dir, "ws.txt", "trailing   \n", "fix: tidy the agent\n\nCo-Authored-By: Someone <a@b.c>");
    commit(dir, "big.ts", "x\n".repeat(501), "feat: big file");
    writeFileSync(join(dir, "code-oss", "upstream.json"), JSON.stringify({ node: "1.0.0" }));
    git(dir, "add", "code-oss/upstream.json");
    git(dir, "commit", "-q", "-m", "chore: pin node");
    const { code, out } = runGate(dir);
    assert.equal(code, 1, out);
    assert.match(out, /FAIL {2}git diff --check/);
    assert.match(out, /FAIL {2}files over 500 lines.*big\.ts \(501\)/);
    assert.match(out, /FAIL {2}commit wording.*co-authored-by, agent/);
    assert.match(out, /FAIL {2}node version.*pins v1\.0\.0/);
    assert.match(out, /verdict: FAILED/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a missing gitleaks binary fails with the pinned install steps from the workflow", () => {
  const dir = setup();
  try {
    const { code, out } = runGate(dir, { GATE_SKIP: "typecheck,test", GATE_GITLEAKS: join(dir, "nope", "gitleaks") });
    assert.equal(code, 1, out);
    assert.match(out, /FAIL {2}gitleaks .*is missing; install the CI pin \(\d+\.\d+\.\d+\)/);
    assert.match(out, /sha256sum -c/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a missing base ref fails the range-based gates", () => {
  const dir = setup();
  try {
    const { code, out } = runGate(dir, { GATE_BASE: "origin/does-not-exist" });
    assert.equal(code, 1, out);
    assert.match(out, /FAIL {2}git diff --check +base ref origin\/does-not-exist not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the caller's GATE_* variables do not leak into the child", () => {
  const dir = setup();
  const saved = { b: process.env.GATE_BASE, g: process.env.GATE_GITLEAKS };
  process.env.GATE_BASE = "origin/does-not-exist";
  process.env.GATE_GITLEAKS = join(dir, "nope");
  try {
    commit(dir, "a.txt", "one\n", "feat: add a file");
    const { code, out } = runGate(dir);
    assert.equal(code, 2, out);
    assert.match(out, /PASS {2}git diff --check/);
  } finally {
    for (const [k, v] of [["GATE_BASE", saved.b], ["GATE_GITLEAKS", saved.g]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a base that moved on does not produce failures for files the branch never touched", () => {
  const dir = setup();
  try {
    git(dir, "checkout", "-q", "main");
    commit(dir, "legacy.txt", "trailing   \n", "chore: legacy file with whitespace");
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(dir, "checkout", "-q", "-b", "chore/old");
    commit(dir, "a.txt", "one\n", "feat: add a file");
    git(dir, "checkout", "-q", "main");
    commit(dir, "legacy.txt", "fixed\n", "chore: fix whitespace");
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(dir, "checkout", "-q", "chore/old");
    const { code, out } = runGate(dir);
    assert.equal(code, 2, out);
    assert.match(out, /PASS {2}git diff --check/);
    assert.match(out, /PASS {2}files over 500 lines +1 changed files/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a renamed file that is rewritten past the limit is flagged, a plain rename is not", () => {
  const dir = setup();
  try {
    commit(dir, "small.ts", "line\n".repeat(400), "feat: small file");
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(dir, "mv", "small.ts", "renamed.ts");
    writeFileSync(join(dir, "renamed.ts"), "line\n".repeat(400) + "more\n".repeat(300));
    git(dir, "add", "renamed.ts");
    git(dir, "commit", "-q", "-m", "refactor: rename and extend");
    const { code, out } = runGate(dir);
    assert.equal(code, 1, out);
    assert.match(out, /FAIL {2}files over 500 lines.*renamed\.ts \(700\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a long file that is only renamed is not flagged", () => {
  const dir = setup();
  try {
    commit(dir, "long.ts", "line\n".repeat(600), "feat: long legacy file");
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(dir, "mv", "long.ts", "moved.ts");
    git(dir, "commit", "-q", "-m", "refactor: move the file");
    const { code, out } = runGate(dir);
    assert.equal(code, 2, out);
    assert.match(out, /PASS {2}files over 500 lines/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skipping a gate prints a loud warning", () => {
  const dir = setup();
  try {
    const { out } = runGate(dir);
    assert.match(out, /WARNING: gitleaks skipped; this run is not a valid pre-push result/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function fakeGitleaks(dir, versionText) {
  const file = join(dir, "fake-gitleaks.mjs");
  const marker = join(dir, "executed.marker");
  writeFileSync(file, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nconsole.log(process.argv[2] === "version" ? ${JSON.stringify(versionText)} : "no leaks found");\n`);
  chmodSync(file, 0o755);
  return file;
}

test("gitleaks: a binary whose version is not the CI pin is refused", { skip: process.platform === "win32" }, () => {
  const dir = setup();
  try {
    const { code, out } = runGate(dir, { GATE_SKIP: "typecheck,test", GATE_GITLEAKS: fakeGitleaks(dir, "0.0.1") });
    assert.equal(code, 1, out);
    assert.match(out, /FAIL {2}gitleaks .*reports "0\.0\.1", CI pins \d+\.\d+\.\d+; refusing to run an unverified binary/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("gitleaks: the recorded binary hash is enforced and reported", { skip: process.platform === "win32" }, () => {
  const dir = setup();
  try {
    const pin = /GITLEAKS_VERSION:\s*(\S+)/.exec(readFileSync(ciYml, "utf8"))[1];
    const bin = fakeGitleaks(dir, pin);
    const env = { GATE_SKIP: "typecheck,test", GATE_GITLEAKS: bin };
    let r = runGate(dir, env);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /PASS {2}gitleaks .*binary hash not recorded/);
    rmSync(join(dir, "executed.marker"));
    writeFileSync(`${bin}.sha256`, `${"0".repeat(64)}  fake-gitleaks.mjs\n`);
    r = runGate(dir, env);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /does not match .*\.sha256; refusing/);
    assert.ok(!existsSync(join(dir, "executed.marker")), "a binary with a wrong hash must never be executed");
    writeFileSync(`${bin}.sha256`, `${createHash("sha256").update(readFileSync(bin)).digest("hex")}  fake-gitleaks.mjs\n`);
    r = runGate(dir, env);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /PASS {2}gitleaks .*hash verified/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the npm test runner runs the renderer-imports suite", () => {
  const src = readFileSync(fileURLToPath(new URL("../../scripts/test-all.mjs", import.meta.url)), "utf8");
  assert.match(src, /test\/code-oss\/renderer-imports\.test\.mjs/);
});

// scripts/test-all.mjs: the runner never stalls or dies silently. Each scenario runs the real runner
// in a child with its own hard external limit, so a disabled limit fails by name and fast, never by hanging.
import { spawn } from "node:child_process";

const testAll = fileURLToPath(new URL("../../scripts/test-all.mjs", import.meta.url));
const node = process.execPath;

function seamEnv(suites, env) {
  const e = { ...process.env, AXIS_TEST_ALL_SUITES_JSON: JSON.stringify(suites), AXIS_TEST_ALL_SEAM: "runner-self-test", ...env };
  delete e.CI;
  return e;
}

function runner(suites, env, hardMs = 15_000) {
  return new Promise((resolve) => {
    const child = spawn(node, [testAll], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: seamEnv(suites, env) });
    let out = "";
    child.stdout.on("data", (d) => { if (out.length < 1_000_000) out += d; });
    child.stderr.on("data", (d) => { if (out.length < 1_000_000) out += d; });
    let hung = false;
    const t = setTimeout(() => { hung = true; try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, hardMs);
    child.on("close", (code) => { clearTimeout(t); resolve({ code, out, hung }); });
  });
}

test("test-all: a spinning suite is killed at its limit, named with its last output, and the runner exits non-zero", { timeout: 25_000 }, async () => {
  const r = await runner([["spin", node, ["-e", "console.log('about to spin'); for (;;) {}"]]], { AXIS_TEST_SUITE_TIMEOUT_MS: "700" });
  assert.equal(r.hung, false, "the runner must have killed the spinning suite within 15 s of its 0.7 s limit");
  assert.match(r.out, /== spin: FAILED \(0 pass, 0 fail, TIMED OUT after 1s \(last output: about to spin\)\)/);
  assert.notEqual(r.code, 0, "a timed-out suite fails the run");
});

test("test-all: output past the cap kills the suite, says so, stops echoing, and the runner exits non-zero", { timeout: 25_000 }, async () => {
  const r = await runner([["flood", node, ["-e", "const b='x'.repeat(65536); setInterval(()=>process.stdout.write(b),1)"]]], { AXIS_TEST_OUTPUT_CAP_BYTES: "200000" });
  assert.equal(r.hung, false, "the runner must have killed the flooding suite within 15 s");
  assert.match(r.out, /== flood: FAILED .*OUTPUT CAP exceeded \(200000 bytes/);
  assert.ok(r.out.length < 400_000, "output past the cap is not echoed");
  assert.notEqual(r.code, 0, "a capped suite fails the run");
});

test("test-all: pass counts, a kill signal and an exit status are reported; a leftover grandchild is killed", { timeout: 25_000 }, async () => {
  const pidFile = join(tmpdir(), `axis-rs-${process.pid}`);
  const orphan = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});c.unref();require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));`;
  const r = await runner([["ok", node, ["-e", "console.log('# pass 3\\n# fail 0')"]], ["sig", node, ["-e", "process.kill(process.pid,'SIGKILL')"]], ["exit", node, ["-e", "process.exit(3)"]], ["orphan", node, ["-e", orphan]]], {});
  assert.equal(r.hung, false, "the runner must finish within 15 s");
  assert.match(r.out, /== ok: ok \(3 pass, 0 fail\)/);
  assert.match(r.out, /== sig: FAILED \(0 pass, 0 fail, killed by SIGKILL\)/);
  assert.match(r.out, /== exit: FAILED \(0 pass, 0 fail, exit 3\)/);
  const pid = Number(readFileSync(pidFile, "utf8"));
  rmSync(pidFile, { force: true });
  let alive = true;
  for (let i = 0; i < 30 && alive; i++) { try { process.kill(pid, 0); await new Promise((res) => setTimeout(res, 100)); } catch { alive = false; } }
  if (alive) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  assert.equal(alive, false, "the runner must have killed the suite's leftover child");
});

import { Writable } from "node:stream";
import { runSuite } from "../../scripts/gate/run-suite.mjs";

test("run-suite: a suite that runs past the sample point prints memory and its biggest processes; a killed one prints them once", { timeout: 20_000, skip: process.platform !== "linux" }, async () => {
  const parts = [];
  const sink = new Writable({ write(c, _e, cb) { parts.push(c); cb(); } });
  await runSuite("slow", node, ["-e", "setTimeout(()=>{},700)"], { sampleMs: 100, sampleAfterMs: 0, out: sink, err: sink });
  const text = Buffer.concat(parts).toString("utf8");
  assert.match(text, /== sample \(slow, \+\d+s, running\): .*Mem:/s);
  // The shape of a process line (rss, pid, command), never which program is among the top five: that is the host's business.
  assert.match(text, /\n    \d+ +\d+ +\S/, "at least one process line: rss, pid, command");
  const killed = [];
  const sink2 = new Writable({ write(c, _e, cb) { killed.push(c); cb(); } });
  await runSuite("spin", node, ["-e", "for(;;){}"], { timeoutMs: 400, graceMs: 200, sampleMs: 0, out: sink2, err: sink2 });
  assert.match(Buffer.concat(killed).toString("utf8"), /== sample \(spin, \+\d+s, timeout\): /);
});

test("test-all: SIGTERM during a suite stops the runner with 143 and no queued suite starts", { timeout: 25_000 }, async () => {
  const suites = [["first", node, ["-e", "console.log('FIRST STARTED'); setInterval(()=>{},1000)"]], ["second", node, ["-e", "console.log('NEXT RAN')"]]];
  const child = spawn(node, [testAll], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: seamEnv(suites, {}) });
  let out = "";
  let sent = false;
  const hard = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, 15_000);
  const code = await new Promise((resolve) => {
    const onData = (d) => { out += d; if (!sent && out.includes("FIRST STARTED")) { sent = true; child.kill("SIGTERM"); } };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (c) => resolve(c));
  });
  clearTimeout(hard);
  assert.ok(sent, "the first suite started");
  assert.ok(!out.includes("NEXT RAN"), "no suite may start after a termination signal");
  assert.equal(code, 143, "the runner exits 143 on SIGTERM");
});

test("test-all: the suite-list seam is refused in CI or without its marker, and a bad limit is refused", { timeout: 25_000 }, async () => {
  const run1 = (env) => new Promise((resolve) => {
    const c = spawn(node, [testAll], { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.on("close", (code) => resolve({ code, out }));
  });
  let r = await run1({ ...seamEnv([], {}), CI: "true" });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /test-only seam; refused/);
  const noMarker = seamEnv([], {});
  delete noMarker.AXIS_TEST_ALL_SEAM;
  r = await run1(noMarker);
  assert.equal(r.code, 2, r.out);
  for (const bad of [{ AXIS_TEST_SUITE_TIMEOUT_MS: "abc" }, { AXIS_TEST_OUTPUT_CAP_BYTES: "0" }]) {
    r = await run1(seamEnv([], bad));
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /must be a positive integer/);
  }
});
