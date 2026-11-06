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
