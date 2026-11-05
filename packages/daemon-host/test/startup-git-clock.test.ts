// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { mock, test } from "node:test";
import { createDaemonHost, createUptimeClock, resolveGitOnce, type Clock } from "../src/index.js";
import { hostFixture } from "../testing/host-fixture.js";

const EXE = process.platform === "win32" ? "git.exe" : "git";

function plantGit(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, EXE);
  writeFileSync(file, process.platform === "win32" ? "MZ" : "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return file;
}

test("git is resolved once and exposed as ONE absolute path; a git in an excluded directory is never chosen", () => {
  const root = mkdtempSync(join(tmpdir(), "axis-git-"));
  try {
    const planted = join(root, "planted");
    const trusted = join(root, "trusted");
    plantGit(planted);
    const good = plantGit(trusted);
    const env = { PATH: [planted, trusted].join(delimiter) };
    const platform = process.platform;
    assert.equal(resolveGitOnce({ env, platform, excludeDirs: [planted] }), good, "the planted one is skipped");
    assert.equal(resolveGitOnce({ env: { PATH: planted }, platform, excludeDirs: [] }), join(planted, EXE), "excluding is what protects");
    assert.throws(() => resolveGitOnce({ env: { PATH: planted }, platform, excludeDirs: [planted] }), { code: "E_UNAVAILABLE" });
    assert.throws(() => resolveGitOnce({ env: { PATH: "" }, platform, excludeDirs: [] }), { code: "E_UNAVAILABLE" });
    assert.throws(() => resolveGitOnce({ env: { PATH: "relative/dir" }, platform, excludeDirs: [] }), { code: "E_UNAVAILABLE" }, "a relative PATH entry is ignored");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the host excludes the worktree root, the data directory, the cwd and registered repositories from the lookup", async () => {
  const fix = hostFixture();
  const cleanups: string[] = [];
  try {
    const repo = join(fix.root, "repo");
    const outside = mkdtempSync(join(tmpdir(), "axis-git-out-"));
    cleanups.push(outside);
    const other = join(outside, "bin");
    const cwd = join(outside, "cwd");
    plantGit(cwd);
    plantGit(fix.worktreeRoot);
    plantGit(repo);
    const good = plantGit(other);
    const env = { PATH: [fix.worktreeRoot, repo, cwd, other].join(delimiter) };
    const registered: string[] = [];
    const host = createDaemonHost(fix.config, { ...fix.ports, env, cwd, registeredRepoRoots: () => registered });
    // The repository is not registered yet: its git would be chosen second, after the worktree root's is skipped.
    registered.push(repo);
    const s = await host.start();
    assert.equal(s.gitPath, good);
    assert.deepEqual(s.excludeDirs(), [fix.worktreeRoot, fix.dataDir, cwd, repo]);
    registered.push(join(fix.root, "later"));
    assert.equal(s.excludeDirs().length, 5, "the list follows later registrations (for the runner's excludeDirs)");
    await host.stop();
  } finally {
    for (const d of cleanups) rmSync(d, { recursive: true, force: true });
    fix.cleanup();
  }
});

test("uptime clock: monotone, a forward jump is clamped, backwards and invalid readings add nothing", () => {
  let t = 1_000;
  const clock: Clock = { now: () => 0, monotonic: () => t };
  const u = createUptimeClock(clock, 60_000);
  assert.equal(u.read(), 0);
  t += 5_000;
  assert.equal(u.read(), 5_000);
  t += 3_600_000; // a suspend, a stepped source
  assert.equal(u.read(), 65_000, "the jump counts as at most maxStepMs");
  t -= 10_000;
  assert.equal(u.read(), 65_000, "backwards adds nothing");
  t += 10_000;
  assert.equal(u.read(), 65_000, "and the way back up adds nothing either: it never counts the same time twice");
  t += 1_000;
  assert.equal(u.read(), 66_000);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const before = u.read();
    t = bad;
    assert.equal(u.read(), before);
  }
  t = 80_000;
  assert.ok(u.read() >= 66_000);
  assert.ok(u.anomalies() >= 5);
  const throwing = createUptimeClock({ now: () => 0, monotonic: () => { throw new Error("x"); } });
  assert.equal(throwing.read(), 0);
  assert.throws(() => createUptimeClock(clock, 5), RangeError);
});

test("the host feeds the idempotency store a bounded clock: a monotonic jump does not expire a key early", async () => {
  let mono = 0;
  const fix = hostFixture({ clock: { now: () => 1_700_000_000_000, monotonic: () => mono } });
  const host = createDaemonHost(fix.config, fix.ports);
  try {
    const s = await host.start();
    const store = s.idempotency;
    assert.ok(store !== undefined);
    const key = { actorId: "user", workspaceId: "w", contract: "axis.worktrees", version: 1, method: "create", key: "k-clock-1" };
    assert.deepEqual(store.begin(key, "h"), { state: "new" });
    store.complete(key, { ok: true }, "c1");
    mono += 30 * 24 * 3_600_000; // a source that leaps a month in one step
    assert.equal(store.begin(key, "h").state, "replay", "the 24 h window did not pass: the jump counted for at most ten minutes");
    mono = Number.NaN;
    assert.equal(store.begin(key, "h").state, "replay", "an invalid reading is hidden from the store, which would otherwise refuse the call");
  } finally {
    await host.stop();
    fix.cleanup();
  }
});

test("uptime clock: a source whose first sample fails starts counting at the first good one", () => {
  const samples: Array<number | "throw"> = ["throw", 100, 160, 220];
  const u = createUptimeClock({ now: () => 0, monotonic: () => { const v = samples.shift(); if (v === "throw" || v === undefined) throw new Error("x"); return v; } }, 60_000);
  assert.equal(u.read(), 0); // construction took the failing sample; this read is the first good one
  assert.equal(u.read(), 60, "counting started");
  assert.equal(u.read(), 120);
});

test("honest idle time is counted: the one-minute tick keeps steps small, so a key expires after 24 h of uptime", async () => {
  let mono = 0;
  const fix = hostFixture({ clock: { now: () => 1_700_000_000_000, monotonic: () => mono } });
  mock.timers.enable({ apis: ["setInterval"] });
  const host = createDaemonHost(fix.config, fix.ports);
  try {
    const s = await host.start();
    const store = s.idempotency;
    assert.ok(store !== undefined);
    const key = { actorId: "user", workspaceId: "w", contract: "axis.worktrees", version: 1, method: "create", key: "k-idle-1" };
    store.begin(key, "h");
    store.complete(key, { ok: true }, "c1");
    for (let i = 0; i < 23 * 60; i++) {
      mono += 60_000;
      mock.timers.tick(60_000);
    }
    assert.equal(store.begin(key, "h").state, "replay", "23 h: still inside the window");
    for (let i = 0; i < 2 * 60; i++) {
      mono += 60_000;
      mock.timers.tick(60_000);
    }
    assert.notEqual(store.begin(key, "h").state, "replay", "25 h of ticks: expired");
  } finally {
    mock.timers.reset();
    await host.stop();
    fix.cleanup();
  }
});

test("a relative or unnormalised excluded directory is refused (it would exclude nothing)", () => {
  for (const bad of ["relative/dir", "", `${tmpdir()}/a/../b`, "/x\0y"]) {
    assert.throws(() => resolveGitOnce({ env: { PATH: "" }, platform: process.platform, excludeDirs: [bad] }), { code: "E_INVALID_ARGUMENT" }, bad);
  }
});
