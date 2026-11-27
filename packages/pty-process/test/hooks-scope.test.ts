// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Step 4's one pinless read: `config --show-scope --get-all core.hooksPath`, judged against the snapshot's raw value (D7).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { judgeHooksPathRead } from "../src/index.js";
import { atLeastGit, GIT, gitRig, nextReq, SKIP, type GitRig } from "../testing/git.js";

const res = (stdout: string, code = 0, truncated = false): { code: number; stdout: string; truncated: boolean } => ({ code, stdout, truncated });

test("judgeHooksPathRead: the winning value must be local or worktree AND byte-equal to the snapshot's raw value", () => {
  const rows: Array<[ReturnType<typeof res>, boolean, string | null, string]> = [
    [res("", 1), true, null, "ok"],
    [res("", 1), true, "hk", "hook_path_unseen"],
    [res("local\thk\n"), true, "hk", "ok"],
    [res("worktree\thk2\n"), true, "hk2", "ok"],
    [res("global\t/u/hooks\nlocal\thk\n"), true, "hk", "ok"],
    [res("local\thk\nglobal\t/u/hooks\n"), true, "hk", "hook_path_unseen"],
    [res("global\t/u/hooks\n"), true, null, "hook_path_unseen"],
    [res("system\t/s/hooks\n"), true, "/s/hooks", "hook_path_unseen"],
    [res("command\t/dev/null\n"), true, "/dev/null", "hook_path_unseen"],
    [res("local\thk\n"), true, null, "hook_path_unseen"],
    [res("local\thk\n"), true, "hk2", "hook_path_unseen"],
    [res("local\t\n"), true, "", "hook_path_unseen"],
    [res("local\thk\nsecond line of a value\n"), true, "hk", "hook_path_unseen"],
    [res("local\thk"), true, "hk", "hook_path_unseen"],
    [res("local\thk\n", 0, true), true, "hk", "hook_path_unseen"],
    [res("", 128), true, null, "hook_path_unseen"],
    [res("hk\n"), false, "hk", "ok"],
    [res("/u/hooks\n"), false, null, "hook_path_unseen"],
    [res("/u/hooks\nhk\n"), false, "hk", "ok"],
  ];
  for (const [r, scope, snap, want] of rows) assert.equal(judgeHooksPathRead(r, scope, snap), want, JSON.stringify([r.stdout, r.code, snap]));
});

/** What the GIT-SNAP-1 snapshot stores: the raw last repository-level value, read with global and system config off. */
function snapshotRaw(r: GitRig, top: string): string | null {
  try {
    const out = execFileSync(GIT as string, ["config", "--get-all", "core.hooksPath"], { cwd: top, env: { ...r.baseEnv, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8" });
    return out.slice(0, -1).split("\n").pop() ?? null;
  } catch {
    return null;
  }
}

async function scopeRead(r: GitRig, repo: { top: string; gitDir: string }): Promise<"ok" | "hook_path_unseen"> {
  const reply = await r.send({ t: "exec", req: nextReq(), argv: [GIT, "config", "--show-scope", "--get-all", "core.hooksPath"], cwd: repo.top, env: {}, timeoutMs: 60_000, maxOutput: 65536, repo: { gitDir: repo.gitDir, workTree: repo.top } });
  assert.equal(reply.t, "exec-result");
  return judgeHooksPathRead(reply as unknown as { code: number; stdout: string; truncated: boolean }, true, snapshotRaw(r, repo.top));
}

const SCOPE_SKIP = SKIP || (atLeastGit([2, 26, 0]) ? false : "config --show-scope needs git 2.26");

test("the pty read accepts a repository-level core.hooksPath and refuses a user-wide one (global alone or winning)", { skip: SCOPE_SKIP }, async (t) => {
  const r = gitRig();
  t.after(() => r.cleanup());
  const local = r.repo("local");
  r.git(["config", "core.hooksPath", ".husky"], local.top);
  assert.equal(await scopeRead(r, local), "ok", "a local value equal to the snapshot's runs (mutation: pin the scope read too, and it reads `command /dev/null`)");
  const plain = r.repo("plain");
  assert.equal(await scopeRead(r, plain), "ok", "unset everywhere");
  writeFileSync(r.globalConfig, `[core]\n\thooksPath = ${join(r.tmp, "user-hooks")}\n`);
  assert.equal(await scopeRead(r, plain), "hook_path_unseen", "a global value the snapshot cannot see");
  assert.equal(await scopeRead(r, local), "ok", "the local value still wins over the global one");
});

test("an includeIf hasconfig:remote.*.url that matches only through global config is refused although its value reads as local", { skip: SKIP || (atLeastGit([2, 36, 0]) ? false : "includeIf hasconfig needs git 2.36") }, async (t) => {
  const r = gitRig();
  t.after(() => r.cleanup());
  const repo = r.repo("hasconfig");
  const inc = join(r.tmp, "hooks.inc");
  writeFileSync(inc, "[core]\n\thooksPath = hk\n");
  r.git(["config", "includeIf.hasconfig:remote.*.url:https://ex.invalid/**.path", inc], repo.top);
  writeFileSync(r.globalConfig, `[remote "origin"]\n\turl = https://ex.invalid/x\n`);
  // Control: with the user's config git really resolves the hook under hk/, while the snapshot sees nothing.
  assert.equal(r.git(["rev-parse", "--git-path", "hooks/pre-commit"], repo.top).trim(), "hk/pre-commit");
  assert.equal(snapshotRaw(r, repo.top), null);
  const reply = await r.send({ t: "exec", req: nextReq(), argv: [GIT, "config", "--show-scope", "--get-all", "core.hooksPath"], cwd: repo.top, env: {}, timeoutMs: 60_000, maxOutput: 65536, repo: { gitDir: repo.gitDir, workTree: repo.top } });
  assert.equal(reply["stdout"], "local\thk\n", "the read shows a local value (a scope-only check would pass it)");
  assert.equal(await scopeRead(r, repo), "hook_path_unseen");
});
