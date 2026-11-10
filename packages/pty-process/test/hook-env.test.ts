// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PTY-5-HOOK: GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE reach a pty child only for a bound attempt, derived by the service.
// Also the S-1 hook checks (hash, realpath containment) and planted hooks run through the service. Real git where needed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { settle, until } from "../testing/helpers.js";
import { begin, GIT, gitRig, nextReq, SKIP, verifyAttempt, type GitRig } from "../testing/git.js";
import { rig, SPEC } from "../testing/rig.js";

const sha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "git_index_file"]) {
  test(`PTY-5-HOOK: a spawn whose env names ${name} is env_denied and nothing starts`, async () => {
    const r = rig();
    await assert.rejects(r.port.spawn({ ...SPEC, env: { ...SPEC.env, [name]: "/x" } }));
    assert.equal(r.requests.length, 0);
  });
}

test("PTY-5-HOOK: spawn has no bind or allow flag: a spawn carrying one is refused by the schema and nothing starts", async () => {
  const r = rig();
  for (const extra of [{ bind: { attempt: "attempt-0001", gitDir: "/w/.git", index: 1 } }, { allowGitRedirect: true }, { attempt: "attempt-0001" }]) {
    r.pair.a.send({ t: "spawn", req: `s-${Object.keys(extra)[0]}`, ...SPEC, ...extra });
  }
  await settle();
  assert.equal(r.requests.length, 0);
  assert.deepEqual(r.pair.sent.b.map((m) => (m as { code?: string }).code), ["spawn_failed", "spawn_failed", "spawn_failed"]);
});

/** A repository with a hook planted at `<gitDir>/hooks/<name>` that records its environment and staged diff, and an attempt ready. */
async function planted(r: GitRig, name: "pre-commit" | "commit-msg", body: string): Promise<{ repo: { top: string; gitDir: string }; hook: string; b: Awaited<ReturnType<typeof begin>>; log: string }> {
  const repo = r.repo("hooked");
  writeFileSync(join(repo.top, "reviewed.txt"), "reviewed\n");
  r.git(["add", "reviewed.txt"], repo.top);
  const tree = r.git(["write-tree"], repo.top).trim();
  r.git(["reset", "-q"], repo.top);
  const log = join(r.tmp, `${name}.log`);
  const hook = join(repo.gitDir, "hooks", name);
  mkdirSync(join(repo.gitDir, "hooks"), { recursive: true });
  writeFileSync(hook, `#!/bin/sh\nexec >> '${log}' 2>&1\necho RAN\n${body}\n`);
  chmodSync(hook, 0o755);
  const b = await begin(r, repo, { tree });
  assert.equal(b.reply["t"], "scratch-ready");
  return { repo, hook, b, log };
}

function hookMsg(r: GitRig, p: { repo: { gitDir: string }; b: { attempt: string } }, name: string, hookPath: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { t: "hook", req: nextReq(), runId: "run-1", attempt: p.b.attempt, bind: { attempt: p.b.attempt, gitDir: p.repo.gitDir, index: 1 }, hook: name, hookPath, expectSha256: sha(hookPath), env: { PATH: r.baseEnv["PATH"], HOME: r.home, GIT_CONFIG_GLOBAL: r.globalConfig, GIT_CONFIG_NOSYSTEM: "1" }, cols: 80, rows: 24, ...extra };
}

async function runHook(r: GitRig, msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reply = await r.send(msg);
  if (reply.t === "spawned") await r.exit(reply.term as string);
  return reply;
}

test("PTY-5-HOOK: a planted pre-commit runs in the pty process with the service-derived redirectors and no replace refs; its diff --cached sees the reviewed tree", { skip: SKIP }, async (t) => {
  const r = gitRig();
  t.after(() => r.cleanup());
  const p = await planted(r, "pre-commit", `env | grep -E '^GIT_(DIR|WORK_TREE|INDEX_FILE|NO_REPLACE_OBJECTS)=' | sort\necho CWD=$(pwd)\n'${GIT}' diff --cached --name-only HEAD`);
  const reply = await runHook(r, hookMsg(r, p, "pre-commit", p.hook));
  assert.equal(reply.t, "spawned");
  const req = r.spawned[r.spawned.length - 1];
  assert.deepEqual(req?.argv, [realpathSync(p.hook)]);
  assert.equal(req?.cwd, p.b.treeDir);
  const out = readFileSync(p.log, "utf8");
  assert.match(out, /^RAN$/m);
  assert.match(out, new RegExp(`^GIT_DIR=${p.repo.gitDir}$`, "m"));
  assert.match(out, new RegExp(`^GIT_WORK_TREE=${p.b.treeDir}$`, "m"));
  assert.match(out, new RegExp(`^GIT_INDEX_FILE=${join(p.b.dir, "index1")}$`, "m"));
  assert.match(out, /^GIT_NO_REPLACE_OBJECTS=1$/m);
  assert.match(out, /^reviewed\.txt$/m, "the hook's staged diff is the reviewed tree against HEAD");
  const v = await verifyAttempt(r, p.b.attempt);
  assert.deepEqual([v["staged"], v["files"], v["message"]], [p.b.tree, "same", "same"]);
});

for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "AXIS_HOOK"]) {
  test(`PTY-5-HOOK: a hook or bound exec whose message env names ${name} is env_denied and nothing runs`, { skip: SKIP }, async (t) => {
    const r = gitRig();
    t.after(() => r.cleanup());
    const p = await planted(r, "pre-commit", "true");
    const before = r.spawned.length;
    const msg = hookMsg(r, p, "pre-commit", p.hook);
    const reply = await r.send({ ...msg, env: { ...(msg["env"] as object), [name]: "/elsewhere" } });
    assert.deepEqual([reply.t, reply["code"]], ["spawn-failed", "env_denied"]);
    assert.equal(r.spawned.length, before);
    const execs = r.execLog.length;
    const ex = await r.send({ t: "exec", req: nextReq(), argv: [GIT, "write-tree"], cwd: p.repo.top, env: { [name]: "/elsewhere" }, timeoutMs: 60_000, maxOutput: 4096, bind: { attempt: p.b.attempt, gitDir: p.repo.gitDir, index: 1 } });
    assert.deepEqual([ex.t, ex["code"]], ["exec-failed", "env_denied"]);
    assert.equal(r.execLog.length, execs, "no git started");
    await settle();
    assert.throws(() => readFileSync(p.log), "the hook never ran");
  });
}

test("PTY-5-HOOK companion: a bound exec with a leading option is bad_argv; an allowed bound exec gets the derived redirectors", { skip: SKIP }, async (t) => {
  const r = gitRig();
  t.after(() => r.cleanup());
  const p = await planted(r, "pre-commit", "true");
  const bind = { attempt: p.b.attempt, gitDir: p.repo.gitDir, index: 2 };
  const bad = await r.send({ t: "exec", req: nextReq(), argv: [GIT, "--git-dir=/x", "write-tree"], cwd: p.repo.top, env: {}, timeoutMs: 60_000, maxOutput: 4096, bind });
  assert.equal(bad["code"], "bad_argv");
  const ok = await r.send({ t: "exec", req: nextReq(), argv: [GIT, "write-tree"], cwd: p.repo.top, env: {}, timeoutMs: 60_000, maxOutput: 4096, bind });
  assert.equal(String(ok["stdout"]).trim(), p.b.tree);
  const sent = r.execLog[r.execLog.length - 1];
  assert.equal(sent?.env["GIT_INDEX_FILE"], join(p.b.dir, "index2"));
  assert.equal(sent?.env["GIT_WORK_TREE"], p.b.treeDir);
  assert.equal(sent?.env["GIT_NO_REPLACE_OBJECTS"], "1");
  // User-level config is isolated: both config locations name the service's own empty file, never the user's.
  const empty = join(r.scratchParent, "hook-scratch", ".empty", "config");
  assert.equal(sent?.env["GIT_CONFIG_GLOBAL"], empty);
  assert.equal(sent?.env["GIT_CONFIG_SYSTEM"], empty);
  assert.equal(readFileSync(empty, "utf8"), "");
  assert.ok(sent?.argv.includes("--no-replace-objects"));
  assert.ok(!sent?.argv.some((a) => a.startsWith("--git-dir") || a.startsWith("--work-tree")), "a command-line --work-tree would override the scratch tree");
});

test("S-1: a hook whose content differs from expectSha256 is hook_changed and does not run", { skip: SKIP }, async (t) => {
  const r = gitRig();
  t.after(() => r.cleanup());
  const p = await planted(r, "pre-commit", "true");
  const msg = hookMsg(r, p, "pre-commit", p.hook);
  writeFileSync(p.hook, readFileSync(p.hook, "utf8") + "echo SWAPPED\n");
  const reply = await runHook(r, msg);
  assert.deepEqual([reply.t, reply["code"]], ["spawn-failed", "hook_changed"]);
  await settle();
  assert.throws(() => readFileSync(p.log));
});

test("S-1: a hook that is not executable is hook_changed; a hookPath whose realpath leaves the hooks dir and the worktree is bad_bind; nothing runs", { skip: SKIP }, async (t) => {
  const r = gitRig();
  t.after(() => r.cleanup());
  const p = await planted(r, "pre-commit", "true");
  chmodSync(p.hook, 0o644);
  assert.equal((await runHook(r, hookMsg(r, p, "pre-commit", p.hook)))["code"], "hook_changed");
  chmodSync(p.hook, 0o755);
  const outside = join(r.tmp, "outside-hook");
  writeFileSync(outside, `#!/bin/sh\necho OUTSIDE >> '${p.log}'\n`);
  chmodSync(outside, 0o755);
  const link = join(p.repo.gitDir, "hooks", "commit-msg");
  symlinkSync(outside, link);
  for (const path of [outside, link, join(p.repo.gitDir, "hooks", "..", "..", "..", "outside-hook")]) {
    const reply = await runHook(r, hookMsg(r, p, "pre-commit", path));
    assert.deepEqual([path, reply["code"]], [path, "bad_bind"]);
  }
  const wrongDir = r.repo("other");
  assert.equal((await runHook(r, hookMsg(r, p, "pre-commit", p.hook, { bind: { attempt: p.b.attempt, gitDir: wrongDir.gitDir, index: 1 } })))["code"], "bad_bind");
  assert.equal((await runHook(r, hookMsg(r, p, "pre-commit", p.hook, { attempt: "attempt-unknown" })))["code"], "bad_bind");
  await settle();
  assert.throws(() => readFileSync(p.log), "nothing ran");
});

test("a hook inside the registered worktree (core.hooksPath=.husky) is accepted and runs", { skip: SKIP }, async (t) => {
  const r = gitRig();
  t.after(() => r.cleanup());
  const p = await planted(r, "pre-commit", "true");
  mkdirSync(join(p.repo.top, ".husky"));
  const husky = join(p.repo.top, ".husky", "pre-commit");
  writeFileSync(husky, `#!/bin/sh\necho HUSKY >> '${p.log}'\n`);
  chmodSync(husky, 0o755);
  assert.equal((await runHook(r, hookMsg(r, p, "pre-commit", husky))).t, "spawned");
  await until(() => {
    try {
      return /HUSKY/.test(readFileSync(p.log, "utf8"));
    } catch {
      return false;
    }
  });
});

test("commit-msg gets the message file as its only argument; a rewrite is reported message: changed, a read-only hook same", { skip: SKIP }, async (t) => {
  const r = gitRig();
  t.after(() => r.cleanup());
  const p = await planted(r, "commit-msg", 'cat "$1"\nif grep -q rewrite "$1"; then echo "Signed: hook" >> "$1"; fi');
  assert.equal((await runHook(r, hookMsg(r, p, "commit-msg", p.hook, { message: "keep me\n" }))).t, "spawned");
  assert.deepEqual(r.spawned[r.spawned.length - 1]?.argv, [realpathSync(p.hook), join(p.b.dir, "msg")]);
  assert.match(readFileSync(p.log, "utf8"), /keep me/);
  assert.equal((await verifyAttempt(r, p.b.attempt))["message"], "same");
  assert.equal((await runHook(r, hookMsg(r, p, "commit-msg", p.hook, { message: "please rewrite\n" }))).t, "spawned");
  assert.equal((await verifyAttempt(r, p.b.attempt))["message"], "changed");
  assert.equal((await runHook(r, hookMsg(r, p, "commit-msg", p.hook)))["code"], "bad_bind", "commit-msg without a message");
});

test("a hook that edits a file or stages a new one is visible to scratch-verify", { skip: SKIP }, async (t) => {
  const r = gitRig();
  t.after(() => r.cleanup());
  const p = await planted(r, "pre-commit", `echo formatted >> reviewed.txt\necho new > new.txt\n'${GIT}' add new.txt`);
  assert.equal((await runHook(r, hookMsg(r, p, "pre-commit", p.hook))).t, "spawned");
  const v = await verifyAttempt(r, p.b.attempt);
  assert.equal(v["files"], "changed");
  assert.notEqual(v["staged"], p.b.tree);
});

test("S-1: the service spawns the realpath it hashed, not the path it was given (a symlink inside the hooks dir)", { skip: SKIP }, async (t) => {
  const r = gitRig();
  t.after(() => r.cleanup());
  const p = await planted(r, "pre-commit", "true");
  const target = join(p.repo.gitDir, "hooks", "pre-commit.real");
  writeFileSync(target, readFileSync(p.hook));
  chmodSync(target, 0o755);
  const link = join(p.repo.gitDir, "hooks", "pre-commit.link");
  symlinkSync("pre-commit.real", link);
  const reply = await runHook(r, hookMsg(r, p, "pre-commit", link));
  assert.equal(reply.t, "spawned");
  assert.deepEqual(r.spawned[r.spawned.length - 1]?.argv, [target]);
});
