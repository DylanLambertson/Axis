// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, constants, existsSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createNodeRunner, type GitRunRequest, type GitRunner } from "@axis/git-ops";
import { createRemoteRunner, displayRemoteUrl, parseRemotes, readRemote, readRepositoryBinding, type BindingFs, type RepositoryBinding } from "../src/index.js";
import { gitUnavailable } from "./review-rig.js";

// The remote shown in main's dialogs (docs/design/project-registration-and-trust.md §5.3).

const POSIX = process.platform !== "win32" && typeof process.getuid === "function";
const GIT_SKIP = POSIX ? gitUnavailable() ?? false : "POSIX only (Windows refuses every binding)";
const env = { PATH: process.env["PATH"], HOME: process.env["HOME"] };

test("the display form drops user info, query and fragment, escapes what could mislead, and is bounded (one mutant each)", () => {
  assert.equal(displayRemoteUrl("https://alice:s3cret@github.com/o/r.git?token=x#frag"), "https://github.com/o/r.git");
  assert.equal(displayRemoteUrl("ssh://git@host:22/o/r.git"), "ssh://host:22/o/r.git");
  assert.equal(displayRemoteUrl("git@github.com:o/r.git"), "github.com:o/r.git");
  assert.equal(displayRemoteUrl("/srv/git/r.git"), "/srv/git/r.git");
  const bidi = displayRemoteUrl("https://host/‮git.exe");
  assert.ok(!bidi.includes("‮") && bidi.includes("\\u{202e}"), bidi);
  assert.ok(!displayRemoteUrl("https://host/a\nb").includes("\n"));
  assert.ok(displayRemoteUrl(`https://host/${"a".repeat(400)}`).length <= 192);
  // Review S1: a `:` in scp-like user info, and a `?` or `#` inside the user info of a URL.
  assert.equal(displayRemoteUrl("user:pass@host:path/x.git"), "host:path/x.git");
  assert.equal(displayRemoteUrl("https://u:p?x@host/a"), "https://host/a");
  assert.equal(displayRemoteUrl("https://u:p#x@host/a"), "https://host/a");
});

test("fuzz: no user info secret survives the display form, whatever surrounds it", () => {
  const SECRET = "S3cr3tT0k3n";
  const users = [`${SECRET}`, `u:${SECRET}`, `${SECRET}:x`, `u:${SECRET}?q`, `u:${SECRET}#f`, `a@b:${SECRET}`, `u:${SECRET}%40`, `:${SECRET}`];
  const forms = [
    (u: string) => `https://${u}@github.com/o/r.git`, (u: string) => `ssh://${u}@host:22/o/r`, (u: string) => `git+ssh://${u}@h/x`,
    (u: string) => `${u}@host:o/r.git`, (u: string) => `${u}@host:/abs/r.git`, (u: string) => `HTTPS://${u}@H/`,
    (u: string) => `https://${u}@host`, (u: string) => `${u}@host:r`, (u: string) => `ftp://${u}@h:21/p?x=1#y`,
  ];
  let n = 0;
  for (const f of forms) for (const u of users) {
    const shown = displayRemoteUrl(f(u));
    assert.ok(!shown.includes(SECRET), `${f(u)} -> ${shown}`);
    n++;
  }
  assert.equal(n, 72);
});

test("parse: origin first, else the first remote; counted and capped; anything else is ignored", () => {
  assert.deepEqual(parseRemotes("remote.up.url\nhttps://u/x\0remote.origin.url\nhttps://o/y\0"), { remote: { name: "origin", url: "https://o/y" }, remotes: 2 });
  assert.deepEqual(parseRemotes("remote.a.b.url\n/p\0"), { remote: { name: "a.b", url: "/p" }, remotes: 1 });
  assert.deepEqual(parseRemotes("core.bare\nfalse\0remote..url\nx\0garbage"), { remote: null, remotes: 0 });
  const many = Array.from({ length: 80 }, (_, i) => `remote.r${i}.url\n/p${i}`).join("\0");
  assert.equal(parseRemotes(many).remotes, 64);
});

function fakeBinding(t: TestContext, config?: string): RepositoryBinding {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "axis-remote-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("mkdir", ["-p", join(root, ".git")]);
  if (config !== undefined) writeFileSync(join(root, ".git", "config"), config);
  return { path: root, commonDir: join(root, ".git"), gitDirId: "1:1" };
}

test("the call carries every daemon pin, the explicit binding, --file and --no-includes (mutant: --no-includes dropped)", { skip: POSIX ? false : "POSIX" }, async (t) => {
  const b = fakeBinding(t, "[remote \"origin\"]\n\turl = https://o/y\n");
  let seen: GitRunRequest | undefined;
  const runner: GitRunner = { run: async (req) => ((seen = req), { code: 0, stdout: "remote.origin.url\nhttps://o/y\0", stderr: "" }) };
  assert.deepEqual(await readRemote(b, { runner, env, platform: process.platform }), { remote: { name: "origin", url: "https://o/y" }, remotes: 1 });
  const argv = seen?.argv ?? [];
  for (const pin of ["core.hooksPath=/dev/null", "core.fsmonitor=false", "protocol.allow=never", "protocol.ext.allow=never", "commit.gpgsign=false", "core.askPass=", "diff.submodule=short", "help.autocorrect=0"]) {
    assert.ok(argv.includes(pin), pin);
  }
  for (const flag of ["--no-pager", "--no-replace-objects", `--git-dir=${b.commonDir}`, `--work-tree=${b.path}`, "--no-includes", "--null"]) assert.ok(argv.includes(flag), flag);
  assert.deepEqual(argv.slice(argv.indexOf("config")), ["config", "--file", join(b.commonDir, "config"), "--no-includes", "--null", "--get-regexp", "^remote\\..*\\.url$"]);
  assert.equal(seen?.env["GIT_NO_LAZY_FETCH"], "1");
  assert.equal(seen?.env["GIT_ALLOW_PROTOCOL"], "/");
  assert.equal(seen?.context, "daemon");
  assert.ok(seen?.signal instanceof AbortSignal);
});

test("a config that is too large, a FIFO or a symlink is refused before git runs; no config is no remote", { skip: POSIX ? false : "POSIX" }, async (t) => {
  let ran = 0;
  const runner: GitRunner = { run: async () => (ran++, { code: 0, stdout: "", stderr: "" }) };
  const deps = { runner, env, platform: process.platform };
  assert.equal(await readRemote(fakeBinding(t, "#".repeat(1_048_577)), deps), undefined, "mutant: size check dropped");
  const fifo = fakeBinding(t);
  execFileSync("mkfifo", [join(fifo.commonDir, "config")]);
  assert.equal(await readRemote(fifo, deps), undefined);
  const linked = fakeBinding(t);
  execFileSync("ln", ["-s", "/etc/hostname", join(linked.commonDir, "config")]);
  assert.equal(await readRemote(linked, deps), undefined);
  assert.equal(ran, 0, "git never ran");
  assert.deepEqual(await readRemote(fakeBinding(t), deps), { remote: null, remotes: 0 });
  // A runner failure or a timeout is "unknown", never a throw.
  const failing: GitRunner = { run: async () => { throw new Error("boom"); } };
  assert.equal(await readRemote(fakeBinding(t, "[core]\n"), { ...deps, runner: failing }), undefined);
  const hung: GitRunner = { run: (req) => new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("killed")))) };
  assert.equal(await readRemote(fakeBinding(t, "[core]\n"), { ...deps, runner: hung, timeoutMs: 30 }), undefined);
});

test("real git on a hostile repository: no program the config names runs, an include FIFO is never opened, the call is bounded", { skip: GIT_SKIP }, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "axis-hostile-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", repo]);
  const marker = join(root, "ran");
  const program = join(root, "evil.sh");
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(program, 0o755);
  const fifo = join(root, "include.fifo");
  execFileSync("mkfifo", [fifo]);
  const cfg = join(repo, ".git", "config");
  writeFileSync(cfg, [
    "[core]", "\trepositoryformatversion = 0", `\tfsmonitor = ${program}`, `\tsshCommand = ${program}`, `\tpager = ${program}`,
    "[include]", `\tpath = ${fifo}`, `[includeIf "gitdir:${repo}/"]`, `\tpath = ${fifo}`,
    "[protocol \"file\"]", "\tallow = always", "[extensions]", "\tpartialClone = origin",
    "[remote \"origin\"]", `\turl = file://${root}/elsewhere.git`, "\tpromisor = true", `\tuploadpack = ${program}`,
    "[alias]", `\tconfig = !${program}`, "",
  ].join("\n"));
  const b = await readRepositoryBinding(repo, { platform: process.platform, uid: (process.getuid as () => number)() });
  assert.equal(b.ok, true);
  if (!b.ok) return;
  const runner = createNodeRunner({ allowUnpinnedGit: true });
  const t0 = performance.now();
  const r = await readRemote(b.binding, { runner, env, platform: process.platform, timeoutMs: 5_000 });
  const took = performance.now() - t0;
  assert.ok(took < 7_000, `bounded (${Math.round(took)} ms)`);
  assert.equal(existsSync(marker), false, "no program named by the repository ran");
  // The FIFO has no writer: had git opened it (an include at startup or in the read), it would have hung until the bound.
  assert.deepEqual(r, { remote: { name: "origin", url: `file://${root}/elsewhere.git` }, remotes: 1 }, "read without following the include");
});

test("review B1: the production runner ends a git blocked on a FIFO swapped in after the lstat, and its process group", { skip: GIT_SKIP }, async (t) => {
  const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const b = fakeBinding(t);
  execFileSync("mkfifo", [join(b.commonDir, "config")]);
  // The lstat lies (the TOCTOU between the check and git's open): a regular, small file.
  const lying: BindingFs = {
    realpath: async (p) => p,
    lstat: async () => ({ isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, uid: 0, dev: 1, ino: 1, size: 10 }),
  };
  const t0 = performance.now();
  // No caller signal and a remote bound far beyond the runner's: only the runner's own 5 s kill can end it.
  const r = await readRemote(b, { runner: createRemoteRunner(gitPath, env), env, platform: process.platform, fs: lying, timeoutMs: 120_000 });
  const took = performance.now() - t0;
  assert.equal(r, undefined);
  assert.ok(took >= 4_000 && took < 40_000, `ended by the runner's bound (5 s; generous ceiling for a loaded machine, the unbounded runner waits 120 s; ${Math.round(took)} ms); mutant: no timeoutMs on the runner`);
  // Nothing is left reading the FIFO: a non-blocking open for writing fails with ENXIO when no process has it open to read.
  assert.throws(() => openSync(join(b.commonDir, "config"), constants.O_WRONLY | constants.O_NONBLOCK), { code: "ENXIO" }, "no git still holds the FIFO");
});

test("the config lstat is under the bound too: a hung filesystem ends at the remote bound", async () => {
  const hung: BindingFs = { realpath: async (p) => p, lstat: () => new Promise(() => undefined) };
  const runner = { run: async () => ({ code: 0, stdout: "", stderr: "" }) };
  const t0 = performance.now();
  const r = await readRemote({ path: "/r", commonDir: "/r/.git", gitDirId: "1:1" }, { runner, env, platform: "linux", fs: hung, timeoutMs: 50 });
  assert.equal(r, undefined);
  assert.ok(performance.now() - t0 < 2_000, "mutant: lstat not bounded");
});
