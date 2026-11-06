// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The git-version branches of bound-call config isolation (§4.3), independent of the host's git.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fakeExec, fakeRig, FAKE_GIT } from "../testing/fake-exec.js";

const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function fakeRepo(t: { after(fn: () => void): void }): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "axis-pty-ver-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gitDir = join(dir, ".git");
  mkdirSync(join(gitDir, "objects"), { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  return gitDir;
}

test("git 2.24 to 2.31: bound calls isolate user config with GIT_CONFIG_NOSYSTEM and empty HOME and XDG_CONFIG_HOME, not GIT_CONFIG_GLOBAL", async (t) => {
  const f = fakeExec({ version: "2.30.0" });
  const r = fakeRig(f.exec);
  t.after(() => r.cleanup());
  const gitDir = fakeRepo(t);
  const begun = await r.send({ t: "scratch-begin", req: "v1", attempt: "attempt-v230", gitDir, worktree: join(gitDir, ".."), tree: TREE });
  assert.equal(begun["t"], "scratch-ready");
  const reply = await r.send({ t: "exec", req: "v2", argv: [FAKE_GIT, "write-tree"], cwd: "/w", env: {}, timeoutMs: 1000, maxOutput: 1000, bind: { attempt: "attempt-v230", gitDir, index: 1 } });
  assert.equal(reply["t"], "exec-result");
  const empty = join(r.scratchParent, "hook-scratch", ".empty");
  for (const req of f.log) {
    assert.equal(req.env["GIT_CONFIG_NOSYSTEM"], "1", req.argv.join(" "));
    assert.equal(req.env["HOME"], empty);
    assert.equal(req.env["XDG_CONFIG_HOME"], empty);
    assert.equal(req.env["GIT_CONFIG_GLOBAL"], undefined, "git before 2.32 ignores it, so it must not be relied on");
  }
  assert.ok(f.log.length >= 3, "ls-tree, read-tree twice and write-tree went through the bound path");
});

test("git before 2.24: scratch-begin and therefore every bound call are refused, and no bound git runs", async (t) => {
  const f = fakeExec({ version: "2.23.0" });
  const r = fakeRig(f.exec);
  t.after(() => r.cleanup());
  const gitDir = fakeRepo(t);
  const begun = await r.send({ t: "scratch-begin", req: "o1", attempt: "attempt-v223", gitDir, worktree: join(gitDir, ".."), tree: TREE });
  assert.deepEqual(begun, { t: "scratch-failed", req: "o1", code: "spawn_failed" });
  const ex = await r.send({ t: "exec", req: "o2", argv: [FAKE_GIT, "write-tree"], cwd: "/w", env: {}, timeoutMs: 1000, maxOutput: 1000, bind: { attempt: "attempt-v223", gitDir, index: 1 } });
  assert.equal(ex["code"], "bad_bind");
  assert.equal(f.log.length, 0);
});

test("MIN_GIT_VERSION: the default adds no floor (pins only); a floor refuses exec and scratch-begin on older git and allows it from that version", async (t) => {
  const { MIN_GIT_VERSION } = await import("../src/index.js");
  assert.equal(MIN_GIT_VERSION, undefined, "default: older git is served with the pins (design §4.1); raising it is the owner's decision");
  const { createPtyService } = await import("../src/index.js");
  const { channelPair, until } = await import("../testing/helpers.js");
  for (const [version, allowed] of [["2.43.0", false], ["2.44.0", true]] as const) {
    const f = fakeExec({ version });
    const scratchParent = realpathSync(mkdtempSync(join(tmpdir(), "axis-pty-min-")));
    const service = createPtyService({ spawn: () => { throw new Error("no spawn"); }, git: { exec: f.exec, gitPath: FAKE_GIT, hooksOff: "/dev/null", scratchParent, baseEnv: {}, minGitVersion: [2, 44, 0] } });
    t.after(() => (service.dispose(), rmSync(scratchParent, { recursive: true, force: true })));
    const pair = channelPair();
    service.serveControl(pair.b);
    const got: Array<Record<string, unknown>> = [];
    pair.a.onMessage((m) => void got.push(m as Record<string, unknown>));
    const gitDir = fakeRepo(t);
    pair.a.send({ t: "exec", req: "m1", argv: [FAKE_GIT, "write-tree"], cwd: "/w", env: {}, timeoutMs: 1000, maxOutput: 1000, repo: { gitDir: "/w/.git", workTree: "/w" } });
    pair.a.send({ t: "scratch-begin", req: "m2", attempt: "attempt-min1", gitDir, worktree: join(gitDir, ".."), tree: TREE });
    await until(() => got.length === 2);
    const by = (req: string): unknown => got.find((m) => m["req"] === req)?.["t"];
    assert.deepEqual([by("m1"), by("m2")], allowed ? ["exec-result", "scratch-ready"] : ["exec-failed", "scratch-failed"], version);
    if (!allowed) assert.equal(f.log.length, 0, "no git beyond the version probe");
  }
});
