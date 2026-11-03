// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
// Regression tests for the data directory checks (existing-directory safety, `..` after a symlink, the lock binding).
import assert from "node:assert/strict";
import { test } from "node:test";
import { AxisError, openDatabase } from "../src/index.js";

// ---- existing data directory safety ----

const posixOnly = { skip: process.platform === "win32" };

async function tmp() {
  const { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const base = realpathSync(mkdtempSync(join(tmpdir(), "axis-dirsafe-")));
  return { base, join, chmodSync, existsSync, mkdirSync, statSync, symlinkSync, done: () => rmSync(base, { recursive: true, force: true }) };
}
const reasonOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof AxisError && e.code === "E_INVALID_ARGUMENT" ? String(e.detail["reason"]) : `other:${String(e)}`;
  }
};

test("data directory: world-writable and group-writable directories are refused, untouched, and no database is created", posixOnly, async () => {
  const t = await tmp();
  try {
    for (const [mode, reason] of [[0o777, "group-writable"], [0o757, "world-writable"], [0o770, "group-writable"], [0o1777, "group-writable"]] as const) {
      const dir = t.join(t.base, `d${mode.toString(8)}`);
      t.mkdirSync(dir);
      t.chmodSync(dir, mode);
      assert.equal(reasonOf(() => openDatabase(t.join(dir, "a.db"))), reason, mode.toString(8));
      assert.equal(t.statSync(dir).mode & 0o7777, mode, "the mode must not be changed");
      assert.equal(t.existsSync(t.join(dir, "a.db")), false, "nothing is created in an unsafe directory");
    }
    const msg = (() => {
      try {
        openDatabase(t.join(t.base, "d777", "a.db"));
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    })();
    assert.ok(!msg.includes(t.base), "the error must not carry the path");
  } finally {
    t.done();
  }
});

test("data directory: a symlinked directory is refused, even when its target is safe", posixOnly, async () => {
  const t = await tmp();
  try {
    const real = t.join(t.base, "real");
    t.mkdirSync(real, { mode: 0o700 });
    t.symlinkSync(real, t.join(t.base, "link"));
    assert.equal(reasonOf(() => openDatabase(t.join(t.base, "link", "a.db"))), "symlink");
    // A symlinked ANCESTOR (as /tmp and /var are on macOS) is fine: the real directory is what is judged.
    const viaAncestor = t.join(t.base, "linkroot");
    t.symlinkSync(t.base, viaAncestor);
    openDatabase(t.join(viaAncestor, "real", "a.db")).close();
  } finally {
    t.done();
  }
});

test("data directory: a directory owned by another user is refused (simulated through the injected stat)", posixOnly, async () => {
  const t = await tmp();
  try {
    const dir = t.join(t.base, "mine");
    t.mkdirSync(dir, { mode: 0o700 });
    const real = {
      lstat: (p: string) => ({ ...t.statSync(p), isSymbolicLink: () => false }),
      stat: (p: string) => t.statSync(p),
      realpath: (p: string) => p,
    };
    const ours = process.getuid?.() ?? 0;
    assert.equal(reasonOf(() => openDatabase(t.join(dir, "a.db"), { directoryFs: { ...real, uid: () => ours + 1 } })), "not-owned");
    openDatabase(t.join(dir, "a.db"), { directoryFs: { ...real, uid: () => ours } }).close();
  } finally {
    t.done();
  }
});

test("data directory: the normal cases pass: an existing 0700 or 0755 directory, and a new one is created 0700", posixOnly, async () => {
  const t = await tmp();
  try {
    for (const mode of [0o700, 0o755, 0o750]) {
      const dir = t.join(t.base, `ok${mode.toString(8)}`);
      t.mkdirSync(dir);
      t.chmodSync(dir, mode);
      openDatabase(t.join(dir, "a.db")).close();
      assert.equal(t.statSync(dir).mode & 0o777, mode, "an existing directory is not chmod-ed");
    }
    const fresh = t.join(t.base, "a", "b");
    openDatabase(t.join(fresh, "a.db")).close();
    assert.equal(t.statSync(fresh).mode & 0o777, 0o700);
    openDatabase(":memory:").close();
  } finally {
    t.done();
  }
});

test("data directory: the instance lock applies the same check to an existing directory", posixOnly, async () => {
  const t = await tmp();
  try {
    const { acquireInstanceLock } = await import("../src/index.js");
    const dir = t.join(t.base, "shared");
    t.mkdirSync(dir);
    t.chmodSync(dir, 0o777);
    assert.equal(reasonOf(() => acquireInstanceLock(dir)), "group-writable");
    t.chmodSync(dir, 0o700);
    acquireInstanceLock(dir).release();
  } finally {
    t.done();
  }
});

// ---- the in-memory carve-out is unreachable from a file-backed database ----

test("guards(): no file-backed database, whatever its name, takes the in-memory carve-out", posixOnly, async () => {
  const t = await tmp();
  try {
    const { acquireInstanceLock } = await import("../src/index.js");
    const other = t.join(t.base, "other");
    t.mkdirSync(other, { mode: 0o700 });
    const elsewhere = acquireInstanceLock(other);
    const mine = t.join(t.base, "mine");
    for (const name of [":memory:", "x.db", "file::memory:", "memory", ":memory:-wal"]) {
      const db = openDatabase(t.join(mine, name));
      assert.equal(elsewhere.guards(db), false, name);
      db.close();
    }
    // A relative "./:memory:" is a file too.
    const cwd = process.cwd();
    process.chdir(mine);
    try {
      const db = openDatabase("./:memory:");
      assert.equal(elsewhere.guards(db), false);
      db.close();
    } finally {
      process.chdir(cwd);
    }
    // A closed database is not guarded; a true in-memory one is, by any held lock.
    const closed = openDatabase(t.join(mine, "c.db"));
    closed.close();
    assert.equal(elsewhere.guards(closed), false);
    assert.equal(elsewhere.guards(openDatabase(":memory:")), true);
    elsewhere.release();
  } finally {
    t.done();
  }
});

test("NEW-J: opening a database in an existing shared directory does not change that directory's mode", { skip: process.platform === "win32" }, async () => {
  const { chmodSync, mkdtempSync, rmSync, statSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "axis-share-"));
  try {
    chmodSync(dir, 0o755);
    openDatabase(join(dir, "x.db")).close();
    assert.equal(statSync(dir).mode & 0o777, 0o755);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- D2-6: `..` after a symlink is judged the way the kernel resolves it ----

test("data directory: `safe/link/../x.db` is judged by where `..` really leads, not by its lexical parent", posixOnly, async () => {
  const t = await tmp();
  try {
    const safe = t.join(t.base, "safe");
    const shared = t.join(t.base, "shared");
    t.mkdirSync(safe, { mode: 0o700 });
    t.mkdirSync(t.join(shared, "sub"), { recursive: true });
    t.chmodSync(shared, 0o777);
    t.symlinkSync(t.join(shared, "sub"), t.join(safe, "link"));
    // (Built by hand: path.join would collapse the `..` before openDatabase ever saw it.)
    // Lexically the parent is `safe` (0700, ours); physically it is `shared` (0777).
    assert.equal(reasonOf(() => openDatabase(`${safe}/link/../x.db`)), "group-writable");
    assert.equal(t.existsSync(t.join(shared, "x.db")), false, "no database may be created in the shared directory");
    assert.equal(t.existsSync(t.join(safe, "x.db")), false);

    // The same shape with a SAFE physical parent is fine, and the database lands where `..` leads.
    const ok = t.join(t.base, "ok");
    t.mkdirSync(t.join(ok, "sub"), { recursive: true });
    t.chmodSync(ok, 0o700);
    t.symlinkSync(t.join(ok, "sub"), t.join(safe, "oklink"));
    openDatabase(`${safe}/oklink/../y.db`).close();
    assert.equal(t.existsSync(t.join(ok, "y.db")), true);
    assert.equal(t.existsSync(t.join(safe, "y.db")), false);

    // A missing directory is never created through a `..` path (it could not be judged first).
    assert.equal(reasonOf(() => openDatabase(`${t.base}/missing/../z.db`)), "dotdot-path");
    assert.equal(t.existsSync(t.join(t.base, "missing")), false);
    // Relative paths work as before.
    const cwd = process.cwd();
    process.chdir(ok);
    try {
      openDatabase("rel.db").close();
      assert.equal(t.existsSync(t.join(ok, "rel.db")), true);
    } finally {
      process.chdir(cwd);
    }
  } finally {
    t.done();
  }
});

test("data directory: the lock and guards() also follow `..` after a symlink physically", posixOnly, async () => {
  const t = await tmp();
  try {
    const { acquireInstanceLock } = await import("../src/index.js");
    const safe = t.join(t.base, "safe");
    const real = t.join(t.base, "real");
    t.mkdirSync(safe, { mode: 0o700 });
    t.mkdirSync(t.join(real, "sub"), { recursive: true });
    t.chmodSync(real, 0o700);
    t.symlinkSync(t.join(real, "sub"), t.join(safe, "link"));
    const raw = `${safe}/link/..`; // physically: real
    const lock = acquireInstanceLock(raw);
    assert.equal(t.existsSync(t.join(real, "axis.lock")), true, "the lock file lives where `..` leads");
    assert.equal(t.existsSync(t.join(safe, "axis.lock")), false);
    const db = openDatabase(`${raw}/j.db`);
    assert.equal(lock.guards(db), true);
    db.close();
    lock.release();
    // A database in `safe` is not guarded by that lock.
    const lock2 = acquireInstanceLock(raw);
    const other = openDatabase(t.join(safe, "k.db"));
    assert.equal(lock2.guards(other), false);
    other.close();
    lock2.release();
  } finally {
    t.done();
  }
});
