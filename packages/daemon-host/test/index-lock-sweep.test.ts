// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AuditLog, openDatabase } from "@axis/audit";
import { Journal } from "@axis/journal";
import { sweepIndexLocks } from "../src/index-lock-sweep.js";

// DC-0b (RR-98): at startup, a stale index.lock is removed only when the journal recorded it as Axis's and the file at that
// path is still the very file recorded (same dev and inode, mtime no later than recorded). Real files. Mutants: a sweep without
// the record, without the inode check, without the mtime check, one that keeps the record, one that leaves index.lock.lock.

function rig(t: TestContext) {
  const root = mkdtempSync(join(process.env["TMPDIR"] ?? "/tmp", "axis-sweep-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = openDatabase(":memory:");
  const journal = Journal.open(db, { audit: new AuditLog(db) });
  const gitDir = (name: string): string => {
    const d = join(root, name, ".git");
    mkdirSync(d, { recursive: true });
    return d;
  };
  /** What the refresh does: record the file now at `path`. */
  const record = (path: string): void => {
    const st = statSync(path, { bigint: true });
    journal.indexLocks.record({ path, dev: st.dev, ino: st.ino, mtimeNs: st.mtimeNs });
  };
  return { root, journal, gitDir, record };
}

test("Axis's own crash lock is removed, with the index.lock.lock its git write left, and the record goes", async (t) => {
  const r = rig(t);
  const lock = join(r.gitDir("a"), "index.lock");
  writeFileSync(lock, "an index copy\n");
  r.record(lock);
  writeFileSync(`${lock}.lock`, "git's write of the copy, cut short\n");
  assert.deepEqual(await sweepIndexLocks(r.journal.indexLocks), { removed: [lock], kept: [] });
  assert.equal(existsSync(lock), false);
  assert.equal(existsSync(`${lock}.lock`), false, "kills a sweep that leaves index.lock.lock");
  assert.deepEqual(r.journal.indexLocks.list(), [], "kills a sweep that keeps the record");
});

test("git's own lock is never touched: one with no record, and one git recreated at a recorded path (a new inode)", async (t) => {
  const r = rig(t);
  const theirs = join(r.gitDir("b"), "index.lock");
  writeFileSync(theirs, "git's own\n");
  const recreated = join(r.gitDir("c"), "index.lock");
  writeFileSync(recreated, "Axis's, then gone\n");
  r.record(recreated);
  const tmp = `${recreated}.new`;
  writeFileSync(tmp, "git's new lock\n"); // a new file, then put at the path: a new inode
  renameSync(tmp, recreated);
  writeFileSync(`${recreated}.lock`, "not provably Axis's\n");
  assert.deepEqual(await sweepIndexLocks(r.journal.indexLocks), { removed: [], kept: [recreated] }, "kills a sweep that ignores the inode");
  assert.equal(existsSync(theirs), true, "kills a sweep without the record");
  assert.equal(existsSync(recreated), true);
  assert.equal(existsSync(`${recreated}.lock`), true, "an index.lock.lock is removed only beside a lock proven Axis's");
  assert.deepEqual(r.journal.indexLocks.list(), [], "the record of a lock that is gone is deleted");
});

test("the lock git rewrote is followed: removed when it was recorded again after the edit, kept when it was not (the residual)", async (t) => {
  const r = rig(t);
  const followed = join(r.gitDir("d"), "index.lock");
  writeFileSync(followed, "copy\n");
  r.record(followed);
  const rewrite = (lock: string): void => {
    writeFileSync(`${lock}.lock`, "git's rewrite\n");
    renameSync(`${lock}.lock`, lock); // what update-index does to the copy: a new inode at the lock path
  };
  rewrite(followed);
  r.record(followed);
  const missed = join(r.gitDir("e"), "index.lock");
  writeFileSync(missed, "copy\n");
  r.record(missed);
  rewrite(missed); // a crash between git's rewrite and the second record
  assert.deepEqual(await sweepIndexLocks(r.journal.indexLocks), { removed: [followed], kept: [missed] });
  assert.equal(existsSync(followed), false);
  assert.equal(existsSync(missed), true, "an unrecorded rewrite is left for the user, as RR-98 says");
});

test("a recorded lock written to after the record (a newer mtime) is kept; a missing one only loses its record", async (t) => {
  const r = rig(t);
  const touched = join(r.gitDir("f"), "index.lock");
  writeFileSync(touched, "copy\n");
  r.record(touched);
  const later = new Date(Date.now() + 60_000);
  utimesSync(touched, later, later);
  const gone = join(r.gitDir("g"), "index.lock");
  writeFileSync(gone, "copy\n");
  r.record(gone);
  rmSync(gone);
  assert.deepEqual(await sweepIndexLocks(r.journal.indexLocks), { removed: [], kept: [touched] }, "kills a sweep without the mtime check");
  assert.equal(existsSync(touched), true);
  assert.deepEqual(r.journal.indexLocks.list(), []);
});

test("a lock that cannot be looked at is kept with its record, for the next start", async (t) => {
  const r = rig(t);
  const lock = join(r.gitDir("h"), "index.lock");
  writeFileSync(lock, "copy\n");
  r.record(lock);
  const fs = { lstat: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }, unlink: async () => assert.fail("nothing is removed") };
  assert.deepEqual(await sweepIndexLocks(r.journal.indexLocks, fs), { removed: [], kept: [lock] });
  assert.equal(r.journal.indexLocks.list().length, 1);
});

test("the same inode on another device, and a recorded path that is a symlink, are kept (kills dropping the dev or the regular-file check)", async (t) => {
  const r = rig(t);
  const other = join(r.gitDir("i"), "index.lock");
  writeFileSync(other, "copy\n");
  const st = statSync(other, { bigint: true });
  r.journal.indexLocks.record({ path: other, dev: st.dev + 1n, ino: st.ino, mtimeNs: st.mtimeNs });
  const link = join(r.gitDir("j"), "index.lock");
  symlinkSync(other, link);
  const ls = lstatSync(link, { bigint: true });
  r.journal.indexLocks.record({ path: link, dev: ls.dev, ino: ls.ino, mtimeNs: ls.mtimeNs });
  assert.deepEqual(await sweepIndexLocks(r.journal.indexLocks), { removed: [], kept: [other, link].sort() });
  assert.equal(existsSync(other), true);
  assert.equal(lstatSync(link).isSymbolicLink(), true);
});
