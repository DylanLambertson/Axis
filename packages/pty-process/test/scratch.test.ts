// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// The raw scratch checkout and its verification (docs/design/daemon-host-hooks.md §5 steps 5 and 8). Real git.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { begin, forgeTree, GIT, gitRig, nextReq, SKIP, verifyAttempt, type GitRig } from "../testing/git.js";

const mode = (p: string): number => lstatSync(p).mode & 0o777;

function fixture(r: GitRig): { top: string; gitDir: string; tree: string } {
  const repo = r.repo("fx");
  writeFileSync(join(repo.top, ".gitattributes"), "*.txt text eol=crlf\n*.bin filter=m\n");
  writeFileSync(join(repo.top, "lf.txt"), "one\ntwo\n");
  writeFileSync(join(repo.top, "data.bin"), "raw-bytes\n");
  mkdirSync(join(repo.top, "sub"));
  writeFileSync(join(repo.top, "sub", "run.sh"), "#!/bin/sh\n");
  chmodSync(join(repo.top, "sub", "run.sh"), 0o755);
  symlinkSync("a.txt", join(repo.top, "rel"));
  symlinkSync("/nonexistent/axis/target", join(repo.top, "abs"));
  symlinkSync("missing-file", join(repo.top, "dang"));
  symlinkSync("sub", join(repo.top, "dirlink"));
  r.git(["add", "-A"], repo.top);
  r.git(["commit", "-q", "--no-verify", "-m", "fixture"], repo.top);
  // Filters configured AFTER the commit: the fill must not run them or convert anything.
  r.git(["config", "filter.m.smudge", r.marker("smudge", "echo SMUDGED\n")], repo.top);
  r.git(["config", "filter.m.process", r.marker("process", "exit 1\n")], repo.top);
  r.git(["config", "filter.m.required", "true"], repo.top);
  return { ...repo, tree: r.git(["rev-parse", "HEAD^{tree}"], repo.top).trim() };
}

test("scratch-begin writes raw blob bytes (no eol, no smudge), modes and symlinks; scratch-verify reports the tree unchanged", { skip: SKIP }, async (t) => {
  const r = gitRig();
  t.after(() => r.cleanup());
  const repo = fixture(r);
  const b = await begin(r, repo);
  assert.equal(b.reply["t"], "scratch-ready");
  assert.equal(readFileSync(join(b.treeDir, "lf.txt"), "utf8"), "one\ntwo\n", "no CRLF conversion");
  assert.equal(readFileSync(join(b.treeDir, "data.bin"), "utf8"), "raw-bytes\n", "no smudge");
  assert.equal(r.markers(), "", "no filter ran");
  assert.equal(mode(join(b.treeDir, "sub", "run.sh")) & 0o100, 0o100);
  assert.equal(mode(join(b.treeDir, "lf.txt")) & 0o111, 0);
  assert.equal(readlinkSync(join(b.treeDir, "rel")), "a.txt");
  assert.equal(readlinkSync(join(b.treeDir, "abs")), "/nonexistent/axis/target");
  assert.equal(readlinkSync(join(b.treeDir, "dang")), "missing-file");
  assert.ok(lstatSync(join(b.treeDir, "dirlink")).isSymbolicLink());
  for (const d of [join(r.scratchParent, "hook-scratch"), b.dir, b.treeDir, join(b.treeDir, "sub")]) assert.equal(mode(d), 0o700, d);
  const v = await verifyAttempt(r, b.attempt);
  assert.deepEqual(v, { t: "scratch-verified", req: v["req"], staged: repo.tree, files: "same", message: "same" });
  assert.equal(r.markers(), "", "no filter ran during verification");
  assert.equal((await r.send({ t: "scratch-end", req: nextReq(), attempt: b.attempt }))["t"], "scratch-ended");
  assert.equal(existsSync(b.dir), false);
});

const CHANGES: Array<[string, (tree: string, r: GitRig, repo: { top: string; gitDir: string }) => void]> = [
  ["a modified file", (d) => writeFileSync(join(d, "lf.txt"), "one\ntwo\nthree\n")],
  ["a same-size modified file", (d) => writeFileSync(join(d, "lf.txt"), "ONE\nTWO\n")],
  ["a removed file", (d) => unlinkSync(join(d, "lf.txt"))],
  ["a new file", (d) => writeFileSync(join(d, "new.txt"), "x")],
  ["a new file hidden by info/exclude and .gitignore", (d, _r, repo) => {
    writeFileSync(join(repo.gitDir, "info", "exclude"), "cache.tmp\n");
    writeFileSync(join(d, "cache.tmp"), "x");
  }],
  ["a new empty directory", (d) => mkdirSync(join(d, "emptydir"))],
  ["an executable bit added", (d) => chmodSync(join(d, "lf.txt"), 0o755)],
  ["an executable bit removed", (d) => chmodSync(join(d, "sub", "run.sh"), 0o644)],
  ["a symlink retargeted", (d) => (unlinkSync(join(d, "rel")), symlinkSync("lf.txt", join(d, "rel")))],
  ["a symlink replaced by its target's bytes", (d) => (unlinkSync(join(d, "rel")), writeFileSync(join(d, "rel"), "a.txt"))],
  ["a file replaced by a symlink to identical bytes", (d) => (writeFileSync(join(d, "..", "copy"), "one\ntwo\n"), unlinkSync(join(d, "lf.txt")), symlinkSync(join(d, "..", "copy"), join(d, "lf.txt")))],
  ["a directory replaced by a symlink to a copy", (d) => {
    execFileSync("cp", ["-a", join(d, "sub"), join(d, "..", "subcopy")]);
    rmSync(join(d, "sub"), { recursive: true });
    symlinkSync(join(d, "..", "subcopy"), join(d, "sub"));
  }],
  ["a file replaced by a FIFO (must not hang)", (d) => {
    unlinkSync(join(d, "lf.txt"));
    execFileSync("mkfifo", [join(d, "lf.txt")]);
  }],
];

for (const [name, change] of CHANGES) {
  test(`scratch-verify reports files: changed for ${name}`, { skip: SKIP }, async (t) => {
    const r = gitRig();
    t.after(() => r.cleanup());
    const repo = fixture(r);
    const b = await begin(r, repo);
    assert.equal(b.reply["t"], "scratch-ready");
    change(b.treeDir, r, repo);
    const v = await verifyAttempt(r, b.attempt);
    assert.equal(v["files"], "changed");
  });
}

test("scratch-verify reports the staged tree a hook's `git add` produced, in either scratch index", { skip: SKIP }, async (t) => {
  const r = gitRig();
  t.after(() => r.cleanup());
  const repo = fixture(r);
  for (const index of ["index1", "index2"]) {
    const b = await begin(r, repo);
    writeFileSync(join(b.treeDir, "added.txt"), "x");
    r.git(["add", "added.txt"], b.treeDir, undefined, { GIT_DIR: repo.gitDir, GIT_WORK_TREE: b.treeDir, GIT_INDEX_FILE: join(b.dir, index) });
    unlinkSync(join(b.treeDir, "added.txt"));
    const v = await verifyAttempt(r, b.attempt);
    assert.notEqual(v["staged"], repo.tree, index);
    assert.match(String(v["staged"]), /^[0-9a-f]{40,64}$/);
    assert.equal(v["files"], "same", "the work tree itself was put back");
    await r.send({ t: "scratch-end", req: nextReq(), attempt: b.attempt });
  }
});

const BLOB = (r: GitRig, top: string, s: string): string => r.git(["hash-object", "-w", "--stdin"], top, s).trim();

test("a forged tree with .git, .., a git~1 short name, an NTFS or HFS spelling of .git, or a case collision is bad_tree and nothing is written outside", { skip: SKIP }, async (t) => {
  const r = gitRig();
  t.after(() => r.cleanup());
  const repo = r.repo("forged");
  const outside = join(r.tmp, "outside");
  mkdirSync(outside);
  const blob = BLOB(r, repo.top, "#!/bin/sh\necho pwned\n");
  const link = BLOB(r, repo.top, outside);
  const sub = forgeTree(r, repo.top, [["100755", blob, "post-checkout"]]);
  const cases: Array<[string, ReadonlyArray<readonly [string, string, string]>]> = [
    [".git directory", [["040000", sub ?? "", ".git"]]],
    [".GIT file", [["100644", blob, ".GIT"]]],
    ["..", [["100644", blob, ".."]]],
    ["git~1", [["100644", blob, "GIT~1"]]],
    [".git with a trailing dot and space", [["100644", blob, ".git. "]]],
    [".git with an NTFS stream", [["100644", blob, ".git::$INDEX_ALLOCATION"]]],
    [".git with an HFS ignorable code point", [["100644", blob, ".g‌it"]]],
    ["a name with a backslash", [["100644", blob, "a\\b"]]],
    ["a case-colliding symlink and directory", [["120000", link, "L"], ["040000", sub ?? "", "l"]]],
    ["a case-colliding symlink and file", [["120000", link, "X"], ["100644", blob, "x"]]],
    ["a normalisation collision", [["100644", blob, "café"], ["100644", blob, "café"]]],
  ];
  for (const [name, rows] of cases) {
    const tree = forgeTree(r, repo.top, rows);
    if (tree === undefined || sub === undefined) {
      t.diagnostic(`${name}: this git's mktree refuses the forged entry, so the case cannot be built here`);
      continue;
    }
    const b = await begin(r, repo, { tree });
    assert.deepEqual([name, b.reply["t"], b.reply["code"]], [name, "scratch-failed", "bad_tree"]);
    assert.deepEqual(readdirSync(outside), [], name);
    assert.equal(existsSync(b.dir), false, `${name}: the attempt is removed`);
  }
  // Positive control: the same blob under a harmless name is written.
  const ok = await begin(r, repo, { tree: forgeTree(r, repo.top, [["100644", blob, "fine"]]) as string });
  assert.equal(ok.reply["t"], "scratch-ready");
});

test("on a case-insensitive file system a case-colliding symlink cannot redirect a write (probe)", { skip: SKIP }, async (t) => {
  const r = gitRig();
  t.after(() => r.cleanup());
  writeFileSync(join(r.tmp, "case-probe"), "");
  if (!existsSync(join(r.tmp, "CASE-PROBE"))) return t.skip("this file system is case-sensitive: the collision is refused by name above and cannot be probed by writing");
  const repo = r.repo("ci");
  const outside = join(r.tmp, "outside-ci");
  mkdirSync(outside);
  const blob = BLOB(r, repo.top, "x");
  const tree = forgeTree(r, repo.top, [["120000", BLOB(r, repo.top, outside), "D"], ["040000", forgeTree(r, repo.top, [["100644", blob, "f"]]) as string, "d"]]) as string;
  const b = await begin(r, repo, { tree });
  assert.equal(b.reply["code"], "bad_tree");
  assert.deepEqual(readdirSync(outside), []);
});

test("scratch attempts: at most two, ids are validated, a duplicate or unknown git dir is bad_bind, channel close removes them all", { skip: SKIP }, async (t) => {
  const r = gitRig();
  t.after(() => r.cleanup());
  const repo = r.repo("cap");
  const a = await begin(r, repo);
  const b = await begin(r, repo);
  assert.equal(b.reply["t"], "scratch-ready");
  assert.equal((await begin(r, repo))["reply"]["code"], "capacity");
  assert.equal((await begin(r, repo, { attempt: a.attempt }))["reply"]["code"], "bad_bind");
  await r.send({ t: "scratch-end", req: nextReq(), attempt: b.attempt });
  const notRepo = await r.send({ t: "scratch-begin", req: nextReq(), attempt: "attempt-norepo", gitDir: r.tmp, worktree: repo.top, tree: a.tree });
  assert.equal(notRepo["code"], "bad_bind");
  const dotdot = await r.send({ t: "scratch-begin", req: nextReq(), attempt: "../escape-1", gitDir: repo.gitDir, worktree: repo.top, tree: a.tree });
  assert.equal(dotdot["code"], "bad_bind");
  assert.equal(existsSync(join(r.scratchParent, "escape-1")), false);
  // A bound exec naming the attempt with another git dir is bad_bind.
  const other = r.repo("other");
  const ex = await r.send({ t: "exec", req: nextReq(), argv: [GIT, "write-tree"], cwd: repo.top, env: {}, timeoutMs: 60_000, maxOutput: 4096, bind: { attempt: a.attempt, gitDir: other.gitDir, index: 1 } });
  assert.equal(ex["code"], "bad_bind");
  assert.ok(existsSync(a.dir));
  r.pair.a.close();
  const { until } = await import("../testing/helpers.js");
  await until(() => !existsSync(a.dir));
  assert.deepEqual(readdirSync(join(r.scratchParent, "hook-scratch")), [".empty"]);
});

test("bound calls do not see the user's global config: a global filter driver is not run by verification (control: plain git runs it)", { skip: SKIP }, async (t) => {
  const r = gitRig();
  t.after(() => r.cleanup());
  const repo = r.repo("glob");
  writeFileSync(join(repo.top, ".gitattributes"), "* filter=g\n");
  r.git(["add", ".gitattributes"], repo.top);
  r.git(["commit", "-q", "--no-verify", "-m", "attrs"], repo.top);
  writeFileSync(r.globalConfig, `[filter "g"]\n\tprocess = ${r.marker("global-filter", "exit 1\n")}\n\tclean = ${r.marker("global-clean", "cat\n")}\n[core]\n\tfsmonitor = ${r.marker("global-fsmonitor", "exit 1\n")}\n`);
  const b = await begin(r, repo);
  assert.equal(b.reply["t"], "scratch-ready");
  // A hook staged the tree again (racily: the index is older than the files), so writing the index compares contents.
  const asHook = { GIT_DIR: repo.gitDir, GIT_WORK_TREE: b.treeDir, GIT_INDEX_FILE: join(b.dir, "index1"), GIT_CONFIG_GLOBAL: "/dev/null" };
  r.git(["add", "-A"], b.treeDir, undefined, asHook);
  const past = new Date(Date.UTC(2001, 0, 1));
  utimesSync(join(b.dir, "index1"), past, past);
  writeFileSync(join(r.tmp, "markers.log"), "");
  // Control: the same write-tree with the user's global config visible runs the global filter.
  try {
    execFileSync(GIT as string, ["write-tree"], { cwd: b.treeDir, env: { ...r.baseEnv, ...asHook, GIT_CONFIG_GLOBAL: r.globalConfig }, stdio: "ignore" });
  } catch {
    /* the marker filter fails on purpose; only whether it started matters */
  }
  assert.match(r.markers(), /global-(filter|clean)/, "control: plain git runs the user's global filter");
  utimesSync(join(b.dir, "index1"), past, past);
  writeFileSync(join(r.tmp, "markers.log"), "");
  const v = await verifyAttempt(r, b.attempt);
  assert.equal(v["t"], "scratch-verified");
  assert.equal(r.markers(), "", "no global filter or fsmonitor ran in a bound call");
});
