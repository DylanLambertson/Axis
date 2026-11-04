// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeRunner, type GitRunRequest, type GitRunner } from "@axis/git-ops";
import { BrokerError, checkGitCall, createBrokerGit, gitCallTier, type GitCall } from "../src/index.js";

const root = "/work/wt";
const refuse = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return (e as BrokerError).reason;
  }
  return "no-error";
};

test("calls: only table commands, exact flags, safe revs, literal relative paths", () => {
  assert.deepEqual(checkGitCall({ command: "diff", flags: ["--stat", "--unified=5"], revs: ["HEAD~2", "main..feature", "abc1234"], paths: ["a/b.ts", "."] }, root, "linux"), {
    flags: ["--stat", "--unified=5"], revs: ["HEAD~2", "main..feature", "abc1234"], paths: ["a/b.ts", "."],
  });
  assert.equal(checkGitCall({ command: "add", paths: ["/work/wt/x.ts"] }, root, "linux").paths[0], "x.ts");
  const cases: Array<[GitCall | unknown, string]> = [
    [{ command: "push" }, "git-command"], [{ command: "__proto__" }, "git-command"], [{ command: "config" }, "git-command"], [null, "git-command"],
    [{ command: "diff", flags: ["--output=/tmp/x"] }, "git-flag"], [{ command: "diff", flags: ["--ext-diff"] }, "git-flag"],
    [{ command: "diff", flags: ["--no-index"] }, "git-flag"], [{ command: "log", flags: ["--exec-path=/x"] }, "git-flag"],
    [{ command: "log", flags: ["--max-count=abc"] }, "git-flag"], [{ command: "log", flags: ["-c", "core.pager=x"] }, "git-flag"],
    [{ command: "status", flags: [5] }, "git-flag"],
    [{ command: "diff", revs: ["--output=/x"] }, "git-rev"], [{ command: "diff", revs: ["-p"] }, "git-rev"], [{ command: "diff", revs: ["a b"] }, "git-rev"],
    [{ command: "diff", revs: ["HEAD:file"] }, "git-rev"], [{ command: "show" }, "git-rev"], [{ command: "status", revs: ["HEAD"] }, "git-rev"],
    [{ command: "add" }, "git-path"], [{ command: "add", paths: ["../x"] }, "dotdot"], [{ command: "add", paths: ["/etc/passwd"] }, "outside-root"],
    [{ command: "add", paths: ["a\\b"] }, "backslash"],
  ];
  for (const [call, why] of cases) assert.equal(refuse(() => checkGitCall(call as GitCall, root, "linux")), why, JSON.stringify(call));
});

test("tiers: restore of the working tree is destructive; staging is not", () => {
  assert.equal(gitCallTier({ command: "status" }), "read");
  assert.equal(gitCallTier({ command: "add", paths: ["a"] }), "write");
  assert.equal(gitCallTier({ command: "restore", flags: ["--staged"], paths: ["a"] }), "write");
  assert.equal(gitCallTier({ command: "restore", paths: ["a"] }), "destructive");
  assert.equal(gitCallTier({ command: "restore", flags: ["--worktree"], paths: ["a"] }), "destructive");
  assert.equal(refuse(() => gitCallTier({ command: "reset" } as never)), "git-command");
});

function fake(): { runner: GitRunner; calls: GitRunRequest[] } {
  const calls: GitRunRequest[] = [];
  return {
    calls,
    runner: {
      async run(req) {
        calls.push(req);
        return req.argv.includes("--get-regexp") ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: "ok", stderr: "" };
      },
    },
  };
}
const w = { workTree: "/work/wt", gitDir: "/work/gitdir" };

test("argv: hardened prefix, explicit dirs, hooks off, user values after the separators, GIT-ENV-1 environment", async () => {
  const f = fake();
  const git = createBrokerGit({ runner: f.runner, parentEnv: { PATH: "/bin", HOME: "/h", GIT_DIR: "/evil", GIT_CONFIG_COUNT: "1", GIT_SSH_COMMAND: "evil", GIT_EXEC_PATH: "/evil", VSCODE_X: "1", GITHUB_TOKEN: "t" }, assertNoDrift: async () => undefined, platform: "linux" });
  await git.run(w, { command: "log", flags: ["--oneline"], revs: ["main"], paths: ["--output=/x", ":(top)*"] });
  const call = f.calls[f.calls.length - 1] as GitRunRequest;
  const a = call.argv;
  for (const need of ["--git-dir=/work/gitdir", "--work-tree=/work/wt", "--no-replace-objects", "--literal-pathspecs", "--no-optional-locks", "core.hooksPath=/dev/null", "core.fsmonitor=false", "protocol.allow=never", "--no-ext-diff", "--no-textconv"]) {
    assert.ok(a.includes(need), need);
  }
  const sub = a.indexOf("log");
  assert.ok(a.indexOf("--git-dir=/work/gitdir") < sub, "global options come before the subcommand");
  assert.deepEqual(a.slice(a.indexOf("--end-of-options")), ["--end-of-options", "main", "--", "--output=/x", ":(top)*"]);
  assert.equal(call.context, "daemon");
  assert.deepEqual(Object.keys(call.env).sort(), ["GIT_TERMINAL_PROMPT", "HOME", "PATH"]);
});

test("drift fails closed: before every call, and after a write", async () => {
  const f = fake();
  let drifted = false;
  const git = createBrokerGit({ runner: f.runner, parentEnv: { PATH: "/bin" }, assertNoDrift: async () => { if (drifted) throw new Error("secret path /x"); }, platform: "linux" });
  await git.run(w, { command: "status" });
  drifted = true;
  const before = f.calls.length;
  await assert.rejects(git.run(w, { command: "status" }), (e: unknown) => e instanceof BrokerError && e.code === "E_CONFLICT" && e.details["executed"] === false && !e.message.includes("secret"));
  assert.equal(f.calls.length, before, "git did not run");
  drifted = false;
  const g2 = createBrokerGit({ runner: f.runner, parentEnv: { PATH: "/bin" }, assertNoDrift: (() => { let n = 0; return async () => { if (++n === 2) throw new Error("x"); }; })(), platform: "linux" });
  await assert.rejects(g2.run(w, { command: "add", paths: ["a"] }), (e: unknown) => e instanceof BrokerError && e.code === "E_CONFLICT" && e.details["executed"] === true);
});

const gitOk = ((): boolean => {
  const r = spawnSync("git", ["--version"], { encoding: "utf8" });
  const m = /git version (\d+)\.(\d+)/.exec(r.stdout ?? "");
  return r.status === 0 && m !== null && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 24));
})();
const posix = process.platform !== "win32";

test("real git: a planted hook, fsmonitor and external diff driver do not run", { skip: !gitOk || !posix }, async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "axis-git-")));
  try {
    const run = (...args: string[]): void => {
      const r = spawnSync("git", args, { cwd: base, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: base, GIT_CONFIG_NOSYSTEM: "1" } });
      assert.equal(r.status, 0, r.stderr);
    };
    run("init", "-q");
    writeFileSync(join(base, "a.txt"), "one\n");
    const marker = join(base, "MARKER");
    const script = (name: string): string => {
      const p = join(base, name);
      writeFileSync(p, `#!/bin/sh\necho ran >> ${marker}\n`);
      chmodSync(p, 0o755);
      return p;
    };
    mkdirSync(join(base, ".git", "hooks"), { recursive: true });
    const hook = join(base, ".git", "hooks", "post-index-change");
    writeFileSync(hook, `#!/bin/sh\necho hook >> ${marker}\n`);
    chmodSync(hook, 0o755);
    appendFileSync(join(base, ".git", "config"), `[core]\n\tfsmonitor = ${script("fsm.sh")}\n[diff]\n\texternal = ${script("ext.sh")}\n`);
    const git = createBrokerGit({ runner: createNodeRunner(), parentEnv: { PATH: process.env["PATH"] ?? "", HOME: base }, assertNoDrift: async () => undefined });
    const wt = { workTree: base, gitDir: join(base, ".git") };
    const add = await git.run(wt, { command: "add", paths: ["a.txt"] });
    assert.equal(add.code, 0, add.stderr);
    writeFileSync(join(base, "a.txt"), "two\n");
    assert.equal((await git.run(wt, { command: "status", flags: ["--short"] })).code, 0);
    const diff = await git.run(wt, { command: "diff" });
    assert.equal(diff.code, 0, diff.stderr);
    assert.ok(diff.stdout.includes("+two"), "a built-in diff, not the external driver");
    assert.equal(existsSync(marker), false, "no hook, fsmonitor or diff driver ran");
    // Control: the same repository without the broker's options does run the hook.
    spawnSync("git", ["add", "a.txt"], { cwd: base, env: { PATH: process.env["PATH"] ?? "", HOME: base } });
    spawnSync("git", ["status"], { cwd: base, env: { PATH: process.env["PATH"] ?? "", HOME: base } });
    assert.equal(existsSync(marker), true, "the fixture is not vacuous");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
