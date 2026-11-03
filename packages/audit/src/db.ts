// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AxisError } from "./errors.js";

export type { DatabaseSync };

/** The file system calls the directory safety check makes; tests inject their own to simulate another owner. */
export interface DirectoryFs {
  lstat(path: string): { readonly mode: number; readonly uid: number; isSymbolicLink(): boolean };
  stat(path: string): { readonly mode: number; readonly uid: number };
  realpath(path: string): string;
  /** The current user's uid. */
  uid(): number;
}

const nodeDirectoryFs: DirectoryFs = {
  lstat: (p) => lstatSync(p),
  stat: (p) => statSync(p),
  // `.native` asks the OS. The JavaScript realpathSync collapses `..` lexically first, which is exactly the mistake
  // this check exists to avoid (`safe/link/..` is not `safe`).
  realpath: (p) => realpathSync.native(p),
  uid: () => process.getuid?.() ?? -1,
};

export interface OpenOptions {
  /** How long a writer waits for another writer's lock. Integer, 0 to 600000 ms. Default 5000. */
  readonly busyTimeoutMs?: number;
  /** Tests only: replace the file system calls used to judge an existing data directory. */
  readonly directoryFs?: DirectoryFs;
}

const POSIX = process.platform !== "win32";
const DARWIN = process.platform === "darwin";

/** SQLite primary result codes the bridge cares about. */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/**
 * Map a raw `node:sqlite` error onto the closed error set: a busy or locked
 * database is retryable `E_UNAVAILABLE`, anything else is `E_INTERNAL`.
 * Neither carries SQLite's message (it can quote SQL and values).
 */
export function mapSqliteError(error: unknown): unknown {
  if (error instanceof AxisError) return error;
  const e = error as { code?: unknown; errcode?: unknown } | null;
  if (e && typeof e === "object" && (e.code === "ERR_SQLITE_ERROR" || typeof e.errcode === "number")) {
    const primary = typeof e.errcode === "number" ? e.errcode & 0xff : 0;
    if (primary === SQLITE_BUSY || primary === SQLITE_LOCKED) {
      return new AxisError("E_UNAVAILABLE", "The database is busy; try again", { sqlite: primary });
    }
    return new AxisError("E_INTERNAL", "Database error", { sqlite: primary });
  }
  return error;
}

/** Run `fn`, converting SQLite errors to `AxisError`. */
export function mapSqlite<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw mapSqliteError(error);
  }
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

/**
 * Check that the database and its `-wal`/`-shm` files are readable only by the
 * owner, tightening them if they are not. No-op on Windows, where mode bits
 * do not apply.
 */
export function assertPrivateFiles(path: string): void {
  if (!POSIX || path === ":memory:") return;
  mapFs(() => {
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      if (!existsSync(file)) continue;
      if ((modeOf(file) & 0o077) !== 0) chmodSync(file, 0o600);
      if ((modeOf(file) & 0o077) !== 0) {
        throw new AxisError("E_UNAVAILABLE", "A database file is readable by other users and could not be tightened");
      }
    }
  });
}

/**
 * Refuse (E_INVALID_ARGUMENT, the reason in `details`, no path in the message) an existing data directory that
 * someone else could use to replace or read the database: the directory itself a symlink, or, after resolving
 * symlinks, not owned by the current user, or writable by group or others. It never changes a mode.
 *
 * What it does NOT cover, on purpose:
 * - Only this directory is judged, not its ancestors (`ensureDataDirectory` does judge the nearest existing ancestor
 *   of a directory it has to create). A parent that another user can write to (not sticky) lets
 *   them rename the checked directory away and plant another, so the data directory belongs under a parent the
 *   user alone controls (the per-user application-data directory is).
 * - Mode bits only. POSIX ACLs (macOS `chmod +a`, Linux `setfacl`) can grant access that the bits do not show,
 *   and are not read.
 * - Windows: there are no owner or mode bits to read here, so the check is skipped (the per-user profile
 *   directory the daemon uses is protected by its ACL).
 *
 * `dir` is passed to the kernel as given, so a `..` after a symlink is resolved physically, the way the database
 * will be opened. Do not normalise it lexically first.
 */
export function assertSafeDirectory(dir: string, fs: DirectoryFs = nodeDirectoryFs): void {
  if (!POSIX) return;
  const refuse = (reason: string): never => {
    throw new AxisError("E_INVALID_ARGUMENT", "The data directory is not safe to use", { reason });
  };
  // Only the last component is judged for being a symlink: ancestors such as /tmp or /var are symlinks on macOS
  // and are fine, because the real directory below is what gets checked.
  if (fs.lstat(dir).isSymbolicLink()) refuse("symlink");
  const real = fs.stat(fs.realpath(dir));
  if (real.uid !== fs.uid()) refuse("not-owned");
  if ((real.mode & 0o020) !== 0) refuse("group-writable");
  if ((real.mode & 0o002) !== 0) refuse("world-writable");
}

/**
 * Map a raw file system error onto the closed error set without its path (Node puts the path in `message`).
 * A bad path (too long, a component that is not a directory, a loop) is the caller's argument; a permission
 * refusal from the OS is a policy denial and is not retryable; a full disk, a busy file or too many open files
 * is `E_UNAVAILABLE` (retryable); anything else is `E_INTERNAL`. Only the errno name is kept, in `detail`.
 */
export function mapFsError(error: unknown): unknown {
  if (error instanceof AxisError) return error;
  const errno = (error as { code?: unknown } | null)?.code;
  if (typeof errno !== "string" || !/^E[A-Z0-9]{2,15}$/.test(errno)) return error;
  const detail = { errno };
  if (["ENAMETOOLONG", "ENOTDIR", "ELOOP", "EINVAL", "EISDIR", "ENOENT"].includes(errno)) {
    return new AxisError("E_INVALID_ARGUMENT", "The data directory path cannot be used", detail);
  }
  if (["EACCES", "EPERM", "EROFS"].includes(errno)) {
    return new AxisError("E_POLICY_DENIED", "The operating system denied access to the data directory", detail);
  }
  if (["ENOSPC", "EDQUOT", "EMFILE", "ENFILE", "EBUSY", "EAGAIN", "ETXTBSY", "ENOMEM"].includes(errno)) {
    return new AxisError("E_UNAVAILABLE", "The data directory is temporarily unavailable", detail);
  }
  return new AxisError("E_INTERNAL", "The data directory could not be prepared", detail);
}

/** Run a file system step, converting its errors with `mapFsError`. */
export function mapFs<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw mapFsError(error);
  }
}

function lstatExists(path: string, fs: DirectoryFs): boolean {
  try {
    fs.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

const hasDotDot = (path: string): boolean => path.split("/").includes("..");

/**
 * The nearest existing ancestor of the missing directory `dir` must not be writable by others, because a
 * directory created inside a 0777 one can be renamed away and replaced by its other writers before the first
 * write. A sticky directory (like /tmp) is fine: only the owner can rename or remove what is inside it. A symlinked
 * ancestor is followed (`~/.config` is often one) and its real directory judged. A sticky directory is safe only
 * if root or the current user owns it, because the sticky bit does not restrict its owner. Otherwise ownership is not required: if
 * the user could not write there, `mkdir` fails with EACCES and that is mapped.
 */
function assertSafeAncestor(dir: string, fs: DirectoryFs): void {
  let ancestor = dirname(dir);
  while (!lstatExists(ancestor, fs)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return;
    ancestor = parent;
  }
  const real = fs.stat(fs.realpath(ancestor));
  if ((real.mode & 0o1000) !== 0) {
    // The sticky bit stops OTHER users renaming or removing entries, not the directory's owner: its owner could
    // rename our new directory away and plant their own. So a sticky ancestor is safe only when root (like /tmp)
    // or the current user owns it.
    if (real.uid !== 0 && real.uid !== fs.uid()) {
      throw new AxisError("E_INVALID_ARGUMENT", "The data directory is not safe to use", { reason: "parent-sticky-foreign-owner" });
    }
    return;
  }
  if ((real.mode & 0o020) !== 0) {
    throw new AxisError("E_INVALID_ARGUMENT", "The data directory is not safe to use", { reason: "parent-group-writable" });
  }
  if ((real.mode & 0o002) !== 0) {
    throw new AxisError("E_INVALID_ARGUMENT", "The data directory is not safe to use", { reason: "parent-world-writable" });
  }
}

/**
 * Make sure the data directory `dir` exists and is safe: an existing one must pass `assertSafeDirectory`; a
 * missing one is created 0700, but never through a path that contains `..` (it could not be judged before it
 * is created, and a `..` after a symlink leads somewhere else) and never inside an ancestor that others can
 * write to, and not inside a sticky one owned by another user (see `assertSafeAncestor`). Shared by `openDatabase` and
 * `acquireInstanceLock`, so the database and its lock follow the same rules. File system errors are mapped
 * without the path (`mapFsError`).
 *
 * `dir` is used as given (not `resolve()`d), because a `..` after a symlink must be resolved physically, as the
 * kernel and SQLite will resolve it.
 */
export function ensureDataDirectory(dir: string, fs: DirectoryFs = nodeDirectoryFs): void {
  mapFs(() => {
    if (!POSIX) {
      mkdirSync(dir, { recursive: true });
      return;
    }
    if (lstatExists(dir, fs)) {
      assertSafeDirectory(dir, fs);
      return;
    }
    if (hasDotDot(dir)) {
      throw new AxisError("E_INVALID_ARGUMENT", "The data directory is not safe to use", { reason: "dotdot-path" });
    }
    assertSafeAncestor(dir, fs);
    const target = resolve(dir);
    if (mkdirSync(target, { recursive: true, mode: 0o700 }) !== undefined) chmodSync(target, 0o700);
    // Judge what is there NOW, whether or not this call created it. Between the ancestor check and mkdir another
    // user can create the directory first (in a sticky parent such as /tmp): mkdir then reports nothing created, and
    // without this check the database would be opened inside a directory they own and can swap files in.
    assertSafeDirectory(dir, fs);
  });
}

function prepareLocation(path: string, fs: DirectoryFs): void {
  if (!POSIX) return;
  // NOT `dirname(resolve(path))`: resolve() collapses `..` lexically, but the kernel (and SQLite) follow a symlink
  // first, so `safe/link/../x.db` lives in link's PARENT, which is not `safe`. Judge the path as the kernel will.
  ensureDataDirectory(dirname(path), fs);
  // Create the file 0600 before SQLite does (its default would follow the umask); -wal and -shm copy its mode.
  mapFs(() => {
    closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
  });
}

function pragma(db: DatabaseSync, sql: string): Record<string, unknown> {
  return db.prepare(sql).get() as Record<string, unknown>;
}

/**
 * Open a journal database with the settings the audit log and the journal
 * rely on: WAL, `synchronous=FULL`, foreign keys, and a busy timeout so
 * concurrent writers queue instead of failing. File mode is 0600 and the
 * directory 0700; every setting is read back and a mismatch is an error.
 *
 * What a committed transaction survives:
 * - a process crash or kill, on every platform (the WAL frames are in the OS
 *   file cache and the OS outlives the process);
 * - power loss, only to the extent the platform's flush reaches stable
 *   storage. Linux: `fsync` after each commit (`synchronous=FULL`). Windows:
 *   `FlushFileBuffers`. macOS: plain `fsync` does NOT flush the drive's write
 *   cache, so this function also turns on `fullfsync` and
 *   `checkpoint_fullfsync` (F_FULLFSYNC) there. In every case a drive or
 *   virtualisation layer that acknowledges a flush it did not perform defeats
 *   the guarantee, and nothing here can detect that.
 */
export function openDatabase(path: string, options: OpenOptions = {}): DatabaseSync {
  const timeout = options.busyTimeoutMs ?? 5000;
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 600_000) {
    throw new AxisError("E_INVALID_ARGUMENT", "busyTimeoutMs must be an integer from 0 to 600000");
  }
  const memory = path === ":memory:";
  if (!memory) prepareLocation(path, options.directoryFs ?? nodeDirectoryFs);
  const db = mapSqlite(() => new DatabaseSync(path));
  try {
    mapSqlite(() => {
      db.exec(`PRAGMA busy_timeout = ${timeout}`);
      if (!memory) {
        const mode = pragma(db, "PRAGMA journal_mode = WAL")["journal_mode"];
        if (mode !== "wal") throw new AxisError("E_UNAVAILABLE", "This file system does not support WAL, which the journal requires");
      }
      db.exec("PRAGMA synchronous = FULL");
      if (DARWIN) {
        db.exec("PRAGMA fullfsync = ON");
        db.exec("PRAGMA checkpoint_fullfsync = ON");
      }
      db.exec("PRAGMA foreign_keys = ON");
    });
    if (pragma(db, "PRAGMA synchronous")["synchronous"] !== 2) throw new AxisError("E_INTERNAL", "Could not enable synchronous=FULL");
    if (DARWIN) {
      if (pragma(db, "PRAGMA fullfsync")["fullfsync"] !== 1) throw new AxisError("E_INTERNAL", "Could not enable fullfsync");
      if (pragma(db, "PRAGMA checkpoint_fullfsync")["checkpoint_fullfsync"] !== 1) {
        throw new AxisError("E_INTERNAL", "Could not enable checkpoint_fullfsync");
      }
    }
    if (pragma(db, "PRAGMA foreign_keys")["foreign_keys"] !== 1) throw new AxisError("E_INTERNAL", "Could not enable foreign keys");
    assertPrivateFiles(path);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

let savepointCounter = 0;

/**
 * Run `fn` atomically. Outside a transaction this is `BEGIN IMMEDIATE` (the
 * write lock is taken up front, which serialises writers across processes);
 * inside one it is a savepoint, so callers can compose (a journal change and
 * its audit event commit or roll back together). SQLite errors leave as
 * `AxisError` (see `mapSqliteError`).
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) {
    const name = `axis_sp_${++savepointCounter}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw error;
    }
  }
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    throw mapSqliteError(error);
  }
}

export interface Migration {
  /** Strictly increasing positive integers starting at 1. */
  readonly version: number;
  readonly sql: string;
}

/**
 * Apply pending migrations for one component (`audit`, `journal`) in a single
 * transaction and record the new schema version in `axis_schema`. A database
 * newer than this build knows is refused rather than guessed at.
 */
export function runMigrations(db: DatabaseSync, component: string, migrations: readonly Migration[]): number {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new AxisError("E_INTERNAL", `Migrations for ${component} must be numbered 1..n in order`);
    }
  });
  const latest = migrations.length;
  return withTransaction(db, () => {
    db.exec("CREATE TABLE IF NOT EXISTS axis_schema (component TEXT PRIMARY KEY, version INTEGER NOT NULL)");
    const row = db.prepare("SELECT version FROM axis_schema WHERE component = ?").get(component) as
      | { version: number }
      | undefined;
    const current = row?.version ?? 0;
    if (current > latest) {
      throw new AxisError("E_UNAVAILABLE", `The ${component} database schema is newer than this build supports`, {
        found: current,
        supported: latest,
      });
    }
    for (const migration of migrations.slice(current)) {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO axis_schema (component, version) VALUES (?, ?) " +
          "ON CONFLICT(component) DO UPDATE SET version = excluded.version",
      ).run(component, migration.version);
    }
    return latest;
  });
}

export function schemaVersion(db: DatabaseSync, component: string): number {
  const exists = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'axis_schema'").get();
  if (!exists) return 0;
  const row = db.prepare("SELECT version FROM axis_schema WHERE component = ?").get(component) as
    | { version: number }
    | undefined;
  return row?.version ?? 0;
}
