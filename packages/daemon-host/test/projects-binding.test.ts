// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { bindingMatches, readRepositoryBinding, type BindingFs } from "../src/index.js";
import { nodeBindingFs } from "../src/projects/binding.js";

// The repository binding without git discovery (docs/design/project-registration-and-trust.md §5.2).

const POSIX = process.platform !== "win32" && typeof process.getuid === "function";
const SKIP = POSIX ? false : "POSIX uid and symlinks are needed (Windows refuses every binding: tested below)";
const uid = POSIX ? (process.getuid as () => number)() : 0;
const opts = { platform: process.platform, uid };

/** A minimal repository as git's own test sees it: `.git` with HEAD, objects/ and refs/. */
function repo(t: TestContext, name = "repo"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "axis-bind-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const p = join(root, name);
  mkdirSync(join(p, ".git", "objects"), { recursive: true });
  mkdirSync(join(p, ".git", "refs"));
  writeFileSync(join(p, ".git", "HEAD"), "ref: refs/heads/main\n");
  return p;
}

const refused = async (path: string, reason = "not_a_repository", o: Partial<Parameters<typeof readRepositoryBinding>[1]> = {}) =>
  assert.deepEqual(await readRepositoryBinding(path, { ...opts, ...o }), { ok: false, reason });

test("a top level with a real .git directory binds to that .git and its <dev>:<ino>", { skip: SKIP }, async (t) => {
  const p = repo(t);
  const r = await readRepositoryBinding(p, opts);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.binding.path, p);
  assert.equal(r.binding.commonDir, join(p, ".git"));
  assert.match(r.binding.gitDirId, /^[0-9]+:[0-9]+$/);
  assert.equal(bindingMatches({ commonDir: r.binding.commonDir, gitDirId: r.binding.gitDirId }, r.binding), true);
});

test("each check refuses on its own (mutant: any one check dropped)", { skip: SKIP }, async (t) => {
  // 1. A symlinked path component: the spelling is not the real path.
  const real = repo(t);
  const link = join(real, "..", "via-link");
  symlinkSync(real, link);
  await refused(link);
  // A folder inside the repository is not its top level.
  mkdirSync(join(real, "sub"));
  await refused(join(real, "sub"));
  // 2. `.git` as a symlink, and as a `gitdir:` file (a linked worktree, a submodule, a separate git directory).
  const symGit = repo(t);
  const elsewhere = repo(t, "elsewhere");
  rmSync(join(symGit, ".git"), { recursive: true });
  symlinkSync(join(elsewhere, ".git"), join(symGit, ".git"));
  await refused(symGit);
  const fileGit = repo(t);
  rmSync(join(fileGit, ".git"), { recursive: true });
  writeFileSync(join(fileGit, ".git"), `gitdir: ${join(elsewhere, ".git")}\n`);
  await refused(fileGit);
  // 3. A `commondir` file (a linked worktree's git directory), a missing HEAD, objects/ or refs/ as a symlink or missing.
  const common = repo(t);
  writeFileSync(join(common, ".git", "commondir"), "../..\n");
  await refused(common);
  const noHead = repo(t);
  rmSync(join(noHead, ".git", "HEAD"));
  await refused(noHead);
  for (const name of ["objects", "refs"]) {
    const linked = repo(t);
    rmSync(join(linked, ".git", name), { recursive: true });
    symlinkSync(join(elsewhere, ".git", name), join(linked, ".git", name));
    await refused(linked);
    const gone = repo(t);
    rmSync(join(gone, ".git", name), { recursive: true });
    await refused(gone);
  }
  // No `.git` at all, and no folder at all.
  await refused(join(real, "sub"));
  await refused(join(real, "missing"));
});

test("4. a .git owned by another user is refused (git's dubious ownership, failing closed)", { skip: SKIP }, async (t) => {
  const p = repo(t);
  await refused(p, "not_a_repository", { uid: uid + 1 });
});

test("Windows (no uid) is refused unavailable, never passed (mutant: check 4 skipped off POSIX)", async (t) => {
  const p = POSIX ? repo(t) : "C:\\repo";
  await refused(p, "unavailable", { platform: "win32" });
  await refused(p, "unavailable", { uid: undefined });
});

test("a hung filesystem or an abort is unavailable within the bound", async () => {
  const hung: BindingFs = { realpath: () => new Promise(() => undefined), lstat: () => new Promise(() => undefined) };
  const t0 = performance.now();
  await refused("/hung/repo", "unavailable", { fs: hung, timeoutMs: 30, uid: 1, platform: "linux" });
  assert.ok(performance.now() - t0 < 2_000);
  const ac = new AbortController();
  const pending = readRepositoryBinding("/hung/repo", { fs: hung, signal: ac.signal, uid: 1, platform: "linux" });
  ac.abort();
  assert.deepEqual(await pending, { ok: false, reason: "unavailable" });
  // An unexpected filesystem error is unavailable too, never a pass.
  const broken: BindingFs = { realpath: async (p) => p, lstat: async () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); } };
  await refused("/broken/repo", "unavailable", { fs: broken, uid: 1, platform: "linux" });
});

test("T2: a .git removed and recreated at the same path is another binding; a row without one never matches", { skip: SKIP }, async (t) => {
  const p = repo(t);
  const first = await readRepositoryBinding(p, opts);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  // Keep the old directory alive under another name so its inode cannot be reused for the new one.
  renameSync(join(p, ".git"), join(p, "old-git"));
  mkdirSync(join(p, ".git", "objects"), { recursive: true });
  mkdirSync(join(p, ".git", "refs"));
  writeFileSync(join(p, ".git", "HEAD"), "ref: refs/heads/main\n");
  const second = await readRepositoryBinding(p, opts);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.binding.commonDir, first.binding.commonDir, "same spelling");
  assert.notEqual(second.binding.gitDirId, first.binding.gitDirId, "a new inode");
  assert.equal(bindingMatches({ commonDir: first.binding.commonDir, gitDirId: first.binding.gitDirId }, second.binding), false, "mutant: git_dir_id not compared");
  assert.equal(bindingMatches({ commonDir: null, gitDirId: null }, second.binding), false, "a pre-v11 row never matches");
  assert.equal(bindingMatches({ commonDir: second.binding.commonDir, gitDirId: null }, second.binding), false);
});

test("the default filesystem reads inodes as bigints (no digit lost on a large inode)", { skip: SKIP }, async (t) => {
  const s = await nodeBindingFs.lstat(repo(t));
  assert.equal(typeof s.ino, "bigint");
});
