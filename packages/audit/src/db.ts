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
  realpath: (p) => realpathSync(p),
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
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(file)) continue;
    if ((modeOf(file) & 0o077) !== 0) chmodSync(file, 0o600);
    if ((modeOf(file) & 0o077) !== 0) {
      throw new AxisError("E_UNAVAILABLE", "A database file is readable by other users and could not be tightened");
    }
  }
}

/**
 * Refuse (E_INVALID_ARGUMENT, the reason in `details`, no path in the message) an existing data directory that
 * someone else could use to replace or read the database: the directory itself a symlink, or, after resolving
 * symlinks, not owned by the current user, or writable by group or others. It never changes a mode. POSIX only:
 * Windows has no owner or mode bits to read here, so the check is skipped there (the per-user profile directory
 * the daemon uses is protected by its ACL).
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

function prepareLocation(path: string, fs: DirectoryFs): void {
  if (!POSIX) return;
  const dir = dirname(resolve(path));
  // A directory this call creates is private (0700). An existing one is the caller's: it is never chmod-ed, but it
  // must be safe (see assertSafeDirectory), because the database and its WAL are only as private as the place
  // they live. The files themselves are always 0600.
  const created = mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (created !== undefined) chmodSync(dir, 0o700);
  else assertSafeDirectory(dir, fs);
  // Create the file 0600 before SQLite does (its default would follow the umask); -wal and -shm copy its mode.
  closeSync(openSync(path, "a", 0o600));
  chmodSync(path, 0o600);
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
