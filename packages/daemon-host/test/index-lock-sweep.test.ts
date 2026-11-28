// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { Journal } from "@axis/journal";
import { sweepIndexLocks, type SweepFs } from "../src/index-lock-sweep.js";

// DC-0b (RR-98): at startup, a stale index.lock is removed only when the journal recorded it as Axis's, the file at that path
// is still exactly the file recorded (a regular file, same dev, inode AND ctime), and the path is the index lock of a
// registered repository (its common git directory, or one of its linked worktrees' directories). Then leftover private copies
// (`index.axis-<16 hex>` and their `.lock`) are removed by name. Real files.
// Mutants: no record needed, no inode check (same dev and ctime), no dev, ctime or regular-file check, a ctime compared with
// `<=` or `>=`, mtime compared instead of ctime, a record cleared after a failed unlink (no retry), no registered-directory
// check, no platform-absolute check, a copy sweep by prefix only, one that ignores a held index.lock, one outside registered
// directories.

const HEX = "0123456789abcdef";
const copyName = (seed: number, lock = false): string => `index.axis-${Array.from({ length: 16 }, (_, i) => HEX[(seed + i * 7) % 16]).join("")}${lock ? ".lock" : ""}`;

function rig(t: TestContext) {
  const root = mkdtempSync(join(process.env["TMPDIR"] ?? "/tmp", "axis-sweep-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  const repos: string[] = [];
  /** A registered repository's common git directory. */
  const repo = (name: string, registered = true): string => {
    const d = join(root, name, ".git");
    mkdirSync(join(d, "worktrees"), { recursive: true });
    if (registered) repos.push(d);
    return d;
  };
  /** A lock file at `path`, recorded as the refresh records it (its identity right after creation). */
  const lock = (path: string, recorded = true): string => {
    writeFileSync(path, "");
    if (recorded) {
      const st = lstatSync(path, { bigint: true });
      journal.indexLocks.record({ path, dev: st.dev, ino: st.ino, ctimeNs: st.ctimeNs });
    }
    return path;
  };
  const sweep = (fs?: Partial<SweepFs>) => sweepIndexLocks({ records: journal.indexLocks, repos }, fs);
  return { root, journal, repo, lock, sweep };
}

test("Axis's own crash lock is removed, in the common directory and in a linked worktree's, and the records go", async (t) => {
  const r = rig(t);
  const git = r.repo("a");
  mkdirSync(join(git, "worktrees", "w"));
  const main = r.lock(join(git, "index.lock"));
  const linked = r.lock(join(git, "worktrees", "w", "index.lock"));
  assert.deepEqual(await r.sweep(), { removed: [main, linked].sort(), kept: [], refused: [], copies: [] });
  assert.equal(existsSync(main), false);
  assert.equal(existsSync(linked), false);
  assert.deepEqual(r.journal.indexLocks.list(), [], "kills a sweep that keeps the record");
});

test("git's own lock is never touched: one with no record, and one git recreated at a recorded path (a new inode)", async (t) => {
  const r = rig(t);
  const theirs = r.lock(join(r.repo("b"), "index.lock"), false);
  const recreated = r.lock(join(r.repo("c"), "index.lock"));
  writeFileSync(`${recreated}.new`, "git's new lock\n");
  renameSync(`${recreated}.new`, recreated);
  assert.deepEqual(await r.sweep(), { removed: [], kept: [recreated], refused: [], copies: [] }, "kills a sweep that ignores the inode");
  assert.equal(existsSync(theirs), true, "kills a sweep without the record");
  assert.equal(existsSync(recreated), true);
  assert.deepEqual(r.journal.indexLocks.list(), [], "the record of a lock that is not ours any more is deleted");
});

test("review 1 B1(b): an inode number reused at the recorded path, its mtime set back to the old one, is kept (the ctime differs)", async (t) => {
  const r = rig(t);
  const path = join(r.repo("d"), "index.lock");
  writeFileSync(path, "");
  const a = lstatSync(path, { bigint: true });
  rmSync(path);
  writeFileSync(path, ""); // another git's lock: on ext4 usually the very inode number just freed
  const back = Number(a.mtimeNs) / 1e9; // the refresh's utimes, or anything else that sets the mtime back
  let b = lstatSync(path, { bigint: true });
  for (let i = 0; i === 0 || (b.ctimeNs === a.ctimeNs && i < 100_000); i++) {
    utimesSync(path, back, back);
    b = lstatSync(path, { bigint: true });
  }
  assert.notEqual(b.ctimeNs, a.ctimeNs, "the kernel set a newer ctime");
  // The record of the first file, on the inode the second one has (what ext4's reuse gives), with the same mtime.
  r.journal.indexLocks.record({ path, dev: b.dev, ino: b.ino, ctimeNs: a.ctimeNs });
  assert.deepEqual(await r.sweep(), { removed: [], kept: [path], refused: [], copies: [] }, "kills a sweep that compares mtime or no time");
  assert.equal(existsSync(path), true);
});

test("the ctime must be exactly the recorded one: one nanosecond earlier or later is kept (kills <= and >=)", async (t) => {
  const r = rig(t);
  const paths = [];
  for (const [name, delta] of [["e", 1n], ["f", -1n]] as const) {
    const path = r.lock(join(r.repo(name), "index.lock"), false);
    const st = lstatSync(path, { bigint: true });
    r.journal.indexLocks.record({ path, dev: st.dev, ino: st.ino, ctimeNs: st.ctimeNs + delta });
    paths.push(path);
  }
  assert.deepEqual(await r.sweep(), { removed: [], kept: paths.sort(), refused: [], copies: [] });
  for (const p of paths) assert.equal(existsSync(p), true);
});

test("review 2 nit 1: the same dev and ctime on another inode is kept (a coarse clock gives two files one ctime; kills dropping the inode check)", async (t) => {
  const r = rig(t);
  const path = r.lock(join(r.repo("q"), "index.lock"), false);
  const st = lstatSync(path, { bigint: true });
  r.journal.indexLocks.record({ path, dev: st.dev, ino: st.ino + 1n, ctimeNs: st.ctimeNs });
  assert.deepEqual(await r.sweep(), { removed: [], kept: [path], refused: [], copies: [] });
  assert.equal(existsSync(path), true);
});

test("the same inode on another device, and a recorded path that is a symlink, are kept (kills dropping the dev or the regular-file check)", async (t) => {
  const r = rig(t);
  const other = r.lock(join(r.repo("i"), "index.lock"), false);
  const st = statSync(other, { bigint: true });
  r.journal.indexLocks.record({ path: other, dev: st.dev + 1n, ino: st.ino, ctimeNs: st.ctimeNs });
  const link = join(r.repo("j"), "index.lock");
  symlinkSync(other, link);
  const ls = lstatSync(link, { bigint: true });
  r.journal.indexLocks.record({ path: link, dev: ls.dev, ino: ls.ino, ctimeNs: ls.ctimeNs });
  assert.deepEqual(await r.sweep(), { removed: [], kept: [other, link].sort(), refused: [], copies: [] });
  assert.equal(existsSync(other), true);
  assert.equal(lstatSync(link).isSymbolicLink(), true);
});

test("a lock that cannot be looked at, or whose removal fails, is kept WITH its record, and the next start removes it (review 1 N1)", async (t) => {
  const r = rig(t);
  const looked = r.lock(join(r.repo("h"), "index.lock"));
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  const noLook: Partial<SweepFs> = { lstat: async () => { throw denied; }, unlink: async () => assert.fail("nothing is removed") };
  assert.deepEqual(await r.sweep(noLook), { removed: [], kept: [looked], refused: [], copies: [] });
  assert.equal(r.journal.indexLocks.list().length, 1);
  const noUnlink: Partial<SweepFs> = { lstat: (p, o) => import("node:fs/promises").then((m) => m.lstat(p, o)), unlink: async () => { throw denied; } };
  assert.deepEqual(await r.sweep(noUnlink), { removed: [], kept: [looked], refused: [], copies: [] });
  assert.equal(r.journal.indexLocks.list().length, 1, "kills clearing the record after a failed unlink");
  assert.equal(existsSync(looked), true);
  assert.deepEqual(await r.sweep(), { removed: [looked], kept: [], refused: [], copies: [] }, "the next start retries");
  assert.equal(existsSync(looked), false);
});

test("review 1 S1: a recorded lock outside every registered repository's index paths is refused: the file stays, the row goes", async (t) => {
  const r = rig(t);
  const git = r.repo("k");
  const outside = r.lock(join(r.repo("unregistered", false), "index.lock"));
  mkdirSync(join(git, "objects"));
  const notIndexDir = r.lock(join(git, "objects", "index.lock"));
  mkdirSync(join(git, "worktrees", "w", "deeper"), { recursive: true });
  const tooDeep = r.lock(join(git, "worktrees", "w", "deeper", "index.lock"));
  const elsewhere = join(r.root, "anywhere");
  mkdirSync(elsewhere);
  const plain = r.lock(join(elsewhere, "index.lock"));
  const all = [outside, notIndexDir, tooDeep, plain].sort();
  assert.deepEqual(await r.sweep(), { removed: [], kept: [], refused: all, copies: [] }, "kills a sweep without the registered-directory check");
  for (const p of all) assert.equal(existsSync(p), true);
  assert.deepEqual(r.journal.indexLocks.list(), []);
});

test("review 1 S1: a stored path that is not absolute on this platform is refused and never resolved against the working directory", { skip: process.platform === "win32" }, async (t) => {
  const r = rig(t);
  r.repo("l");
  const windowsForm = "C:\\repo\\.git\\index.lock"; // on POSIX a RELATIVE name
  r.journal.indexLocks.record({ path: windowsForm, dev: 1n, ino: 1n, ctimeNs: 1n });
  const touched: string[] = [];
  const fs: Partial<SweepFs> = {
    lstat: (p, o) => (touched.push(p), import("node:fs/promises").then((m) => m.lstat(p, o))),
    unlink: (p) => (touched.push(p), unlink(p)),
  };
  assert.deepEqual(await r.sweep(fs), { removed: [], kept: [], refused: [windowsForm], copies: [] });
  assert.equal(touched.includes(windowsForm), false, "kills a sweep without the platform-absolute check");
  assert.deepEqual(r.journal.indexLocks.list(), []);
});

test("leftover private copies are removed by their exact name in registered directories with no index.lock, and nothing else", async (t) => {
  const r = rig(t);
  const git = r.repo("m");
  mkdirSync(join(git, "worktrees", "w"));
  const gone = [join(git, copyName(1)), join(git, copyName(2, true)), join(git, "worktrees", "w", copyName(3))];
  for (const p of gone) writeFileSync(p, "a copy of the index\n");
  const stays = [
    join(git, "index.axis-0123"), // too short
    join(git, `${copyName(4)}.bak`),
    join(git, copyName(5).toUpperCase().replace("INDEX.AXIS-", "index.axis-")), // not lower-case hex
    join(git, `x${copyName(6)}`),
  ];
  for (const p of stays) writeFileSync(p, "not a copy\n");
  mkdirSync(join(git, copyName(7)));
  symlinkSync(join(git, "index.axis-0123"), join(git, copyName(8)));
  const held = r.repo("n");
  r.lock(join(held, "index.lock"), false); // a git (or another daemon's refresh) holds the lock right now
  const live = join(held, copyName(9));
  writeFileSync(live, "a copy in use\n");
  const unregistered = join(r.repo("o", false), copyName(10));
  writeFileSync(unregistered, "not ours to look at\n");
  const swept = await r.sweep();
  assert.deepEqual(swept.copies, gone.sort());
  for (const p of gone) assert.equal(existsSync(p), false);
  for (const p of stays) assert.equal(existsSync(p), true, `${p}: kills a sweep by prefix`);
  assert.equal(lstatSync(join(git, copyName(7))).isDirectory(), true);
  assert.equal(lstatSync(join(git, copyName(8))).isSymbolicLink(), true);
  assert.equal(existsSync(live), true, "kills a sweep that ignores a held index.lock");
  assert.equal(existsSync(unregistered), true, "kills a sweep outside registered directories");
});

test("the copies beside a crash lock are removed in the same start, once that lock is proven Axis's and removed", async (t) => {
  const r = rig(t);
  const git = r.repo("p");
  const lock = r.lock(join(git, "index.lock"));
  const copy = join(git, copyName(11));
  writeFileSync(copy, "the crashed refresh's copy\n");
  assert.deepEqual(await r.sweep(), { removed: [lock], kept: [], refused: [], copies: [copy] });
  assert.equal(existsSync(copy), false);
});
