// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// PTY-EXEC-1 (argv and env half): `exec` is not a launcher. The marker half is exec-markers.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkExecArgv, type GitVersion } from "../src/index.js";
import { fakeExec, fakeRig, FAKE_GIT, out } from "../testing/fake-exec.js";
import { settle } from "../testing/helpers.js";

const OID = "0123456789abcdef0123456789abcdef01234567";
const OID2 = "89abcdef0123456789abcdef0123456789abcdef";
const V: GitVersion = [2, 53, 0];
const ok = (rest: string[], bound = false, version: GitVersion | undefined = V): boolean => checkExecArgv([FAKE_GIT, ...rest], { gitPath: FAKE_GIT, bound, version }).ok;

const REFUSED: Array<[string, string[]]> = [
  ["config edit", ["config", "edit"]],
  ["config set", ["config", "set", "user.name", "x"]],
  ["config <key> <value> (a write)", ["config", "core.sshCommand", "/tmp/x"]],
  ["config --edit", ["config", "--edit"]],
  ["config -e", ["config", "-e"]],
  ["config --list", ["config", "--list"]],
  ["config --get-regexp", ["config", "--get-regexp", "credential"]],
  ["config --get of a key outside the list", ["config", "--get", "credential.helper"]],
  ["config --global --get", ["config", "--global", "--get", "user.name"]],
  ["config --file --get", ["config", "--file", "/x", "--get", "user.name"]],
  ["config --show-scope --get-all credential.helper", ["config", "--show-scope", "--get-all", "credential.helper"]],
  ["config --show-scope --get-all remote.origin.url", ["config", "--show-scope", "--get-all", "remote.origin.url"]],
  ["config --get-all core.hooksPath without --show-scope (git 2.26+)", ["config", "--get-all", "core.hooksPath"]],
  ["config --show-origin --show-scope --get-all core.hooksPath", ["config", "--show-origin", "--show-scope", "--get-all", "core.hooksPath"]],
  ["config --show-scope --show-origin --get-all core.hooksPath", ["config", "--show-scope", "--show-origin", "--get-all", "core.hooksPath"]],
  ["config --show-origin --get user.name", ["config", "--show-origin", "--get", "user.name"]],
  ["config abbreviation --ed", ["config", "--ed"]],
  ["config abbreviation --show-sc", ["config", "--show-sc", "--get-all", "core.hooksPath"]],
  ["remote show", ["remote", "show", "origin"]],
  ["diff", ["diff"]],
  ["log", ["log"]],
  ["update-ref", ["update-ref", "refs/heads/x", OID]],
  ["two-positional symbolic-ref (a write)", ["symbolic-ref", "HEAD", "refs/heads/x"]],
  ["symbolic-ref of another ref", ["symbolic-ref", "refs/x"]],
  ["read-tree without bind", ["read-tree", OID]],
  ["cat-file --filters", ["cat-file", "--filters", "HEAD:a"]],
  ["cat-file --textconv", ["cat-file", "--textconv", "HEAD:a"]],
  ["cat-file --batch-command", ["cat-file", "--batch-command"]],
  ["cat-file --batch abbreviated", ["cat-file", "--batch-c"]],
  ["hash-object without --no-filters", ["hash-object", "--stdin"]],
  ["hash-object with a path", ["hash-object", "--no-filters", "--stdin", "/etc/passwd"]],
  ["hash-object with a path instead of stdin", ["hash-object", "--no-filters", "/etc/passwd"]],
  ["hash-object -w", ["hash-object", "-w", "--no-filters", "--stdin"]],
  ["hash-object --no-filter abbreviation", ["hash-object", "--no-filter", "--stdin"]],
  ["commit-tree with -m", ["commit-tree", "-p", OID, "-m", "x", OID2]],
  ["commit-tree with a key id glued to -S", ["commit-tree", "-SKEY", "-p", OID, "-F", "-", OID2]],
  ["rev-parse abbreviation --verif", ["rev-parse", "--verif", "HEAD"]],
  ["rev-parse --short=4 (a glued value)", ["rev-parse", "--short=4", "HEAD"]],
  ["rev-parse --git-path outside hooks/", ["rev-parse", "--git-path", "config"]],
  ["rev-parse --parseopt", ["rev-parse", "--parseopt"]],
  ["var -l (lists config)", ["var", "-l"]],
  ["var GIT_EDITOR", ["var", "GIT_EDITOR"]],
  ["rev-list --all (no positional)", ["rev-list", "--all"]],
  ["ls-tree --name-only", ["ls-tree", "--name-only", "HEAD"]],
  ["leading -c", ["-c", "core.pager=x", "rev-parse", "HEAD"]],
  ["leading --git-dir=", ["--git-dir=/x", "rev-parse", "HEAD"]],
  ["leading -C", ["-C", "/x", "rev-parse", "HEAD"]],
  ["leading --work-tree", ["--work-tree=/x", "write-tree"]],
  ["leading --exec-path", ["--exec-path=/x", "write-tree"]],
  ["leading --config-env", ["--config-env=core.pager=X", "write-tree"]],
  ["leading --namespace", ["--namespace=x", "write-tree"]],
  ["leading --no-pager", ["--no-pager", "write-tree"]],
  ["leading abbreviation --no-pag", ["--no-pag", "write-tree"]],
  ["an alias name", ["ci", "-m", "x"]],
  ["commit", ["commit", "-m", "x"]],
  ["fetch", ["fetch"]],
  ["push", ["push", "origin", "HEAD"]],
  ["clone", ["clone", "file:///x", "/y"]],
  ["rebase", ["rebase", "HEAD~1"]],
];

for (const [name, rest] of REFUSED) {
  test(`PTY-EXEC-1: ${name} is bad_argv`, () => assert.equal(ok(rest), false));
}

test("PTY-EXEC-1: the allowed forms pass (the refusals above are not vacuous)", () => {
  for (const rest of [
    ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD"],
    ["rev-parse", "--git-path", "hooks/pre-commit", "--git-path", "hooks/commit-msg"],
    ["rev-parse", "--abbrev-ref", "HEAD"],
    ["ls-tree", "-r", "-z", OID],
    ["rev-list", "--objects", "-n", "1", OID],
    ["rev-list", "--parents", "HEAD"],
    ["write-tree"],
    ["var", "GIT_AUTHOR_IDENT"],
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    ["cat-file", "--batch"],
    ["cat-file", "--batch-check"],
    ["cat-file", "-e", OID],
    ["cat-file", "-p", "HEAD:a.txt"],
    ["hash-object", "--no-filters", "--stdin"],
    ["hash-object", "-t", "blob", "--no-filters", "--stdin"],
    ["config", "--get", "user.name"],
    ["config", "--type=bool", "--get", "commit.gpgsign"],
    ["config", "--get", "remote.origin.url"],
    ["config", "--show-scope", "--get-all", "core.hooksPath"],
    ["commit-tree", "-p", OID, "-F", "-", OID2],
    ["commit-tree", "-S", "-p", OID, "-F", "-", OID2],
  ]) {
    assert.equal(ok(rest), true, rest.join(" "));
  }
  assert.equal(ok(["read-tree", OID], true), true, "read-tree with bind");
});

test("PTY-EXEC-1: argv[0] must be the service's own git, and the pinless read is never bound", () => {
  assert.equal(checkExecArgv(["/usr/bin/git", "write-tree"], { gitPath: FAKE_GIT, bound: false, version: V }).ok, false);
  assert.equal(checkExecArgv(["git", "write-tree"], { gitPath: FAKE_GIT, bound: false, version: V }).ok, false);
  assert.equal(ok(["config", "--show-scope", "--get-all", "core.hooksPath"], true), false);
});

test("PTY-EXEC-1: before git 2.26 only the scope-less hooksPath read is allowed, and an unknown version allows neither", () => {
  assert.equal(ok(["config", "--get-all", "core.hooksPath"], false, [2, 25, 4]), true);
  assert.equal(ok(["config", "--show-scope", "--get-all", "core.hooksPath"], false, [2, 25, 4]), false);
  const unknown = { gitPath: FAKE_GIT, bound: false, version: undefined };
  assert.equal(checkExecArgv([FAKE_GIT, "config", "--get-all", "core.hooksPath"], unknown).ok, false);
  assert.equal(checkExecArgv([FAKE_GIT, "config", "--show-scope", "--get-all", "core.hooksPath"], unknown).ok, false);
});

const REPO = { gitDir: "/w/.git", workTree: "/w" };
const base = { t: "exec", cwd: "/w", env: {}, timeoutMs: 1000, maxOutput: 1000, repo: REPO };

for (const name of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "HOME", "XDG_CONFIG_HOME", "GIT_SSH_COMMAND", "GIT_SSH", "GIT_PROXY_COMMAND", "GIT_TRACE", "GIT_TRACE_PACKET", "GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_ALLOW_PROTOCOL", "PATH", "git_dir"]) {
  test(`PTY-EXEC-1: a message env naming ${name} is env_denied and nothing runs`, async (t) => {
    const f = fakeExec();
    const r = fakeRig(f.exec);
    t.after(() => r.cleanup());
    const reply = await r.send({ ...base, req: "e1", argv: [FAKE_GIT, "write-tree"], env: { [name]: "/tmp/trace" } });
    assert.deepEqual(reply, { t: "exec-failed", req: "e1", code: "env_denied" });
    assert.equal(f.log.length, 0);
  });
}

test("PTY-EXEC-1: every exec carries the service prefix; only the exact hooksPath scope read drops the hooks pin", async (t) => {
  const f = fakeExec();
  const r = fakeRig(f.exec);
  t.after(() => r.cleanup());
  const pins = ["-c", "core.fsmonitor=", "-c", "protocol.allow=never", "-c", "protocol.ext.allow=never"];
  const head = ["--no-pager", "--no-replace-objects", "--git-dir=/w/.git", "--work-tree=/w"];
  const env = { GIT_AUTHOR_NAME: "A", LC_ALL: "C" };
  const cases: Array<[string[], string[]]> = [
    [["config", "--get", "user.name"], [...head, "-c", "core.hooksPath=/dev/null", ...pins]],
    [["config", "--type=bool", "--get", "commit.gpgsign"], [...head, "-c", "core.hooksPath=/dev/null", ...pins]],
    [["write-tree"], [...head, "-c", "core.hooksPath=/dev/null", ...pins]],
    [["commit-tree", "-p", OID, "-F", "-", OID2], [...head, "-c", "core.hooksPath=/dev/null", ...pins, "-c", "i18n.commitEncoding=utf-8"]],
    [["config", "--show-scope", "--get-all", "core.hooksPath"], [...head, ...pins]],
  ];
  let n = 0;
  for (const [rest, prefix] of cases) {
    const reply = await r.send({ ...base, req: `p${++n}`, argv: [FAKE_GIT, ...rest], env });
    assert.equal(reply["t"], "exec-result");
    const sent = f.log[f.log.length - 1];
    assert.deepEqual(sent?.argv, [FAKE_GIT, ...prefix, ...rest], rest.join(" "));
    assert.equal(sent?.env["GIT_NO_LAZY_FETCH"], "1");
    assert.equal(sent?.env["GIT_AUTHOR_NAME"], "A");
    assert.equal(sent?.env["LC_ALL"], "C");
    assert.equal(sent?.env["GIT_ALLOW_PROTOCOL"], "/", "the startup GIT_ALLOW_PROTOCOL=file is replaced by an allow-list no transport can match");
    assert.equal(sent?.env["HOME"], "/home/u", "the user's own global config applies to plain calls");
    for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) assert.equal(sent?.env[k], undefined);
  }
});

test("PTY-EXEC-1: exactly one of repo and bind; a bind naming no registered attempt is bad_bind", async (t) => {
  const f = fakeExec();
  const r = fakeRig(f.exec);
  t.after(() => r.cleanup());
  const { repo: _repo, ...noRepo } = base;
  assert.equal((await r.send({ ...noRepo, req: "b1", argv: [FAKE_GIT, "write-tree"] }))["code"], "bad_bind");
  const bind = { attempt: "attempt-0001", gitDir: "/w/.git", index: 1 };
  assert.equal((await r.send({ ...base, req: "b2", argv: [FAKE_GIT, "write-tree"], bind }))["code"], "bad_bind");
  assert.equal((await r.send({ ...noRepo, req: "b3", argv: [FAKE_GIT, "write-tree"], bind }))["code"], "bad_bind");
  assert.equal(f.log.length, 0);
});

test("exec: output over maxOutput is cut and flagged even if the exec function kept more", async (t) => {
  const f = fakeExec({ answer: () => out("x".repeat(5000)) });
  const r = fakeRig(f.exec);
  t.after(() => r.cleanup());
  const reply = await r.send({ ...base, req: "o1", argv: [FAKE_GIT, "write-tree"], maxOutput: 100 });
  assert.equal(reply["truncated"], true);
  assert.equal((reply["stdout"] as string).length, 100);
});

test("exec: a timeout kills the command and answers timeout; capacity refuses past maxExecs", async (t) => {
  const f = fakeExec({ answer: (q) => (q.argv.includes("write-tree") ? "hang" : out("refs/heads/main\n")) });
  const r = fakeRig(f.exec, 1);
  t.after(() => r.cleanup());
  r.pair.a.send({ ...base, req: "h1", argv: [FAKE_GIT, "write-tree"] });
  await settle();
  assert.equal(f.log.length, 1);
  assert.equal((await r.send({ ...base, req: "h2", argv: [FAKE_GIT, "write-tree"] }))["code"], "capacity");
  r.clock.fire();
  await settle();
  assert.equal((await r.send({ ...base, req: "h3", argv: [FAKE_GIT, "symbolic-ref", "HEAD"] }))["t"], "exec-result");
  assert.deepEqual(r.replies.find((x) => x["req"] === "h1"), { t: "exec-failed", req: "h1", code: "timeout" });
  assert.equal(f.killed, 1);
});

test("exec: a malformed exec is answered exec-failed and never run; a data channel cannot send exec, hook or scratch", async (t) => {
  const f = fakeExec();
  const r = fakeRig(f.exec);
  t.after(() => r.cleanup());
  assert.deepEqual(await r.send({ ...base, req: "m1", argv: [FAKE_GIT, "write-tree"], extra: 1 }), { t: "exec-failed", req: "m1", code: "bad_argv" });
  assert.deepEqual(await r.send({ t: "scratch-begin", req: "m2", attempt: "../../etc", gitDir: "/w/.git", worktree: "/w", tree: OID }), { t: "scratch-failed", req: "m2", code: "bad_bind" });
  const { channelPair } = await import("../testing/helpers.js");
  const d = channelPair();
  r.service.serveData(d.b, "conn1");
  const got: unknown[] = [];
  d.a.onMessage((m) => void got.push(m));
  for (const m of [
    { ...base, req: "d1", argv: [FAKE_GIT, "write-tree"] },
    { t: "scratch-begin", req: "d2", attempt: "attempt-0001", gitDir: "/w/.git", worktree: "/w", tree: OID },
    { t: "hook", req: "d3", runId: "r", attempt: "attempt-0001", bind: { attempt: "attempt-0001", gitDir: "/w/.git", index: 1 }, hook: "pre-commit", hookPath: "/w/.git/hooks/pre-commit", expectSha256: "0".repeat(64), env: {}, cols: 80, rows: 24 },
  ]) d.a.send(m);
  await settle();
  assert.deepEqual(got, [0, 1, 2].map(() => ({ t: "refused", term: null, code: "unsupported" })));
  assert.equal(f.log.length, 0);
});

test("exec: every configured filter driver is pinned off before the subcommand; a driver name a pin cannot carry refuses the call", async (t) => {
  const f = fakeExec({ filters: "filter.lfs.clean\0filter.lfs.process\0filter.a.b.smudge\0" });
  const r = fakeRig(f.exec);
  t.after(() => r.cleanup());
  await r.send({ ...base, req: "f1", argv: [FAKE_GIT, "write-tree"] });
  const argv = f.log[f.log.length - 1]?.argv ?? [];
  const pins = ["filter.lfs.clean=", "filter.lfs.smudge=", "filter.lfs.process=", "filter.a.b.clean=", "filter.a.b.smudge=", "filter.a.b.process=", "filter.lfs.required=false", "filter.a.b.required=false"];
  for (const p of pins) assert.equal(argv[argv.indexOf(p) - 1], "-c", p);
  assert.ok(argv.indexOf("filter.lfs.clean=") < argv.indexOf("write-tree"));
  const bad = fakeExec({ filters: "filter.x=y.clean\0" });
  const r2 = fakeRig(bad.exec);
  t.after(() => r2.cleanup());
  assert.deepEqual(await r2.send({ ...base, req: "f2", argv: [FAKE_GIT, "write-tree"] }), { t: "exec-failed", req: "f2", code: "spawn_failed" });
  assert.equal(bad.log.length, 0);
});

test("exec: a request in flight when the control channel closes never starts its git, and its reply is not sent", async (t) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((res) => (release = res));
  const f = fakeExec({ filterGate: gate });
  const r = fakeRig(f.exec);
  t.after(() => r.cleanup());
  r.pair.a.send({ ...base, req: "c1", argv: [FAKE_GIT, "write-tree"], timeoutMs: 600_000 });
  await settle();
  r.pair.a.close();
  await settle();
  release();
  await settle();
  assert.equal(f.log.length, 0, "the subcommand was never started");
  assert.equal(r.replies.length, 0);
});

test("exec: capacity counts requests at entry, not only started children (two requests in one tick)", async (t) => {
  const f = fakeExec();
  const r = fakeRig(f.exec, 1);
  t.after(() => r.cleanup());
  await r.send({ ...base, req: "w0", argv: [FAKE_GIT, "write-tree"] }); // the version is cached from here on
  r.pair.a.send({ ...base, req: "q1", argv: [FAKE_GIT, "write-tree"] });
  r.pair.a.send({ ...base, req: "q2", argv: [FAKE_GIT, "write-tree"] });
  await settle();
  assert.deepEqual(["q1", "q2"].map((q) => r.replies.find((x) => x["req"] === q)?.["t"]), ["exec-result", "exec-failed"]);
  assert.equal(r.replies.find((x) => x["req"] === "q2")?.["code"], "capacity");
});
