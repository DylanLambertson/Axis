// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Smoke test: runs scripts/gate.mjs against a throwaway git repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function runGate(cwd, env = {}) {
  const r = spawnSync(process.execPath, [gate], {
    cwd, encoding: "utf8", env: { ...process.env, GATE_SKIP: SKIP_HEAVY, ...env }
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
