// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { DatabaseSync } from "node:sqlite";
import { AxisError } from "./errors.js";

export type { DatabaseSync };

export interface OpenOptions {
  /** How long a writer waits for another writer's lock. Default 5000 ms. */
  readonly busyTimeoutMs?: number;
}

/**
 * Open a journal database with the settings the audit log and the journal
 * rely on: WAL, `synchronous=FULL` (a committed transaction survives power
 * loss, not only a process crash), foreign keys, and a busy timeout so
 * concurrent writers queue instead of failing.
 */
export function openDatabase(path: string, options: OpenOptions = {}): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = ${Math.trunc(options.busyTimeoutMs ?? 5000)}`);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

let savepointCounter = 0;

/**
 * Run `fn` atomically. Outside a transaction this is `BEGIN IMMEDIATE` (the
 * write lock is taken up front, which serialises writers across processes);
 * inside one it is a savepoint, so callers can compose (a journal change and
 * its audit event commit or roll back together).
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
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
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
