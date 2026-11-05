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

// ---- the instance lock follows the same rules as the database directory ----

test("lock: a missing directory is never created through a `..` path, and nothing is created", posixOnly, async () => {
  const t = await tmp();
  try {
    const { acquireInstanceLock } = await import("../src/index.js");
    // Built by hand: path.join would collapse the `..` before the lock saw it.
    assert.equal(reasonOf(() => acquireInstanceLock(`${t.base}/missing/../data`)), "dotdot-path");
    assert.equal(t.existsSync(t.join(t.base, "missing")), false);
    assert.equal(t.existsSync(t.join(t.base, "data")), false);
    // The database and the lock now agree: both refuse, for the same reason.
    assert.equal(reasonOf(() => openDatabase(`${t.base}/missing/../data/a.db`)), "dotdot-path");
    // An existing directory reached through `..` is judged and allowed when safe, and the lock lands where `..` leads.
    const real = t.join(t.base, "real");
    t.mkdirSync(t.join(real, "sub"), { recursive: true });
    t.chmodSync(real, 0o700);
    const lock = acquireInstanceLock(`${real}/sub/..`);
    assert.equal(t.existsSync(t.join(real, "axis.lock")), true);
    lock.release();
    // A missing directory with no `..` is created 0700 by the lock, as before.
    const made = acquireInstanceLock(t.join(t.base, "newdata"));
    assert.equal(t.statSync(t.join(t.base, "newdata")).mode & 0o777, 0o700);
    made.release();
  } finally {
    t.done();
  }
});

// ---- a missing directory is not created inside an ancestor that others can write to ----

test("ancestor: `safe/badleaf/newdir/x.db` does not create newdir inside a 0777 directory", posixOnly, async () => {
  const t = await tmp();
  try {
    const { acquireInstanceLock } = await import("../src/index.js");
    const badleaf = t.join(t.base, "safe", "badleaf");
    t.mkdirSync(badleaf, { recursive: true });
    t.chmodSync(t.join(t.base, "safe"), 0o700);
    for (const [mode, reason] of [[0o777, "parent-group-writable"], [0o757, "parent-world-writable"], [0o770, "parent-group-writable"]] as const) {
      t.chmodSync(badleaf, mode);
      assert.equal(reasonOf(() => openDatabase(`${badleaf}/newdir/x.db`)), reason, mode.toString(8));
      assert.equal(reasonOf(() => acquireInstanceLock(`${badleaf}/newdir`)), reason, `lock ${mode.toString(8)}`);
      // The nearest EXISTING ancestor is what counts, however many levels are missing.
      assert.equal(reasonOf(() => openDatabase(`${badleaf}/a/b/c/x.db`)), reason);
      assert.equal(t.existsSync(t.join(badleaf, "newdir")), false);
      assert.equal(t.existsSync(t.join(badleaf, "a")), false);
      assert.equal(t.statSync(badleaf).mode & 0o777, mode, "the ancestor's mode is not changed");
    }
    // A private ancestor is fine.
    t.chmodSync(badleaf, 0o700);
    openDatabase(`${badleaf}/newdir/x.db`).close();
    assert.equal(t.statSync(t.join(badleaf, "newdir")).mode & 0o777, 0o700);
  } finally {
    t.done();
  }
});

test("ancestor: a sticky world-writable ancestor (like /tmp) and a symlinked ancestor are allowed", posixOnly, async () => {
  const t = await tmp();
  try {
    const sticky = t.join(t.base, "sticky");
    t.mkdirSync(sticky);
    t.chmodSync(sticky, 0o1777);
    openDatabase(`${sticky}/mine/x.db`).close();
    assert.equal(t.statSync(t.join(sticky, "mine")).mode & 0o777, 0o700);

    const real = t.join(t.base, "realparent");
    t.mkdirSync(real, { mode: 0o700 });
    t.symlinkSync(real, t.join(t.base, "dotdir")); // like a ~/.config that points into a dotfiles checkout
    openDatabase(`${t.base}/dotdir/axis/x.db`).close();
    assert.equal(t.existsSync(t.join(real, "axis", "x.db")), true);

    // A symlinked ancestor whose target is 0777 is judged by the target.
    const open777 = t.join(t.base, "open777");
    t.mkdirSync(open777);
    t.chmodSync(open777, 0o777);
    t.symlinkSync(open777, t.join(t.base, "openlink"));
    assert.equal(reasonOf(() => openDatabase(`${t.base}/openlink/axis/x.db`)), "parent-group-writable");
  } finally {
    t.done();
  }
});

// ---- FU-1: a directory another user creates between the ancestor check and mkdir is judged, not trusted ----

test("race: a directory planted after the ancestor check is judged by the final check", posixOnly, async () => {
  const t = await tmp();
  try {
    const ours = process.getuid?.() ?? 0;
    const real = {
      lstat: (p: string) => ({ ...t.statSync(p), isSymbolicLink: () => false }),
      stat: (p: string) => t.statSync(p),
      realpath: (p: string) => p,
    };
    // The hook plants the data directory at the moment the ancestor is judged: after that check, before mkdir.
    const planting = (target: string, mode: number, uidAfter: number) => {
      let planted = false;
      return {
        ...real,
        // The data directory does not exist until planted; every other path is real.
        lstat: (p: string) => {
          if (p === target && !planted) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          return { ...t.statSync(p), isSymbolicLink: () => false };
        },
        stat: (p: string) => {
          if (!planted && p !== target) {
            t.mkdirSync(target);
            t.chmodSync(target, mode);
            planted = true;
          }
          return t.statSync(p);
        },
        uid: () => (planted ? uidAfter : ours),
      };
    };
    // 1. The planted directory is world-writable.
    const open777 = t.join(t.base, "open777");
    const hookA = { ...planting(open777, 0o777, ours) };
    assert.equal(reasonOf(() => openDatabase(`${open777}/x.db`, { directoryFs: hookA })), "group-writable");
    assert.equal(t.existsSync(t.join(open777, "x.db")), false, "no database inside the planted directory");

    // 2. The planted directory LOOKS private but belongs to someone else (the injected uid stands in for the other user).
    const foreign = t.join(t.base, "foreign");
    const hookB = { ...planting(foreign, 0o700, ours + 1) };
    assert.equal(reasonOf(() => openDatabase(`${foreign}/x.db`, { directoryFs: hookB })), "not-owned");
    assert.equal(t.existsSync(t.join(foreign, "x.db")), false);
  } finally {
    t.done();
  }
});

// ---- FU-2: a sticky ancestor must belong to root or to the current user ----

const notRoot = { skip: process.platform === "win32" || process.getuid?.() === 0 ? "root owns everything the test creates" : false };

test("sticky ancestor: allowed when root or the current user owns it, refused when anyone else does", notRoot, async () => {
  const t = await tmp();
  try {
    const ours = process.getuid?.() ?? 0;
    const sticky = t.join(t.base, "sticky");
    t.mkdirSync(sticky);
    t.chmodSync(sticky, 0o1777);
    const withOwner = (owner: number, uid: number) => ({
      lstat: (p: string) => ({ ...t.statSync(p), isSymbolicLink: () => false }),
      stat: (p: string) => ({ mode: t.statSync(p).mode, uid: p === sticky ? owner : t.statSync(p).uid }),
      realpath: (p: string) => p,
      uid: () => uid,
    });
    // Owned by someone else (an injected uid stands in for them): refused, and nothing is created.
    assert.equal(reasonOf(() => openDatabase(`${sticky}/mine/x.db`, { directoryFs: withOwner(ours + 1, ours) })), "parent-sticky-foreign-owner");
    assert.equal(t.existsSync(t.join(sticky, "mine")), false);
    // Owned by root (as /tmp is) or by the current user: allowed.
    openDatabase(`${sticky}/rootowned/x.db`, { directoryFs: withOwner(0, ours) }).close();
    openDatabase(`${sticky}/ours/x.db`, { directoryFs: withOwner(ours, ours) }).close();
    assert.equal(t.existsSync(t.join(sticky, "rootowned", "x.db")), true);
    assert.equal(t.existsSync(t.join(sticky, "ours", "x.db")), true);
  } finally {
    t.done();
  }
});
