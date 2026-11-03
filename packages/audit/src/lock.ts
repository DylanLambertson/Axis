// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { assertSafeDirectory } from "./db.js";
import { AxisError } from "./errors.js";

const LOCK_FILE = "axis.lock";
/** A lock file that cannot be parsed is treated as held until it is this old (it may be mid-write). */
const UNPARSEABLE_GRACE_MS = 5000;

interface LockRecord {
  readonly pid: number;
  /** Start time of the holder as the OS reports it; guards against a reused pid. */
  readonly procStart: string | null;
  readonly startedAt: number;
  readonly nonce: string;
}

const MINT = Symbol("axis.instanceLock.mint");

/**
 * Proof that this process holds the database directory, minted only by
 * `acquireInstanceLock`. The `#` fields are a brand: `InstanceLock.is(x)` is
 * true only for an object this class constructed, so an object literal with
 * the right-looking fields is not one. `Journal.recover` requires one that is
 * still held and that guards the journal's own database directory.
 */
export class InstanceLock {
  readonly #path: string;
  readonly #nonce: string;
  #held = true;

  /** Not constructible outside this module: use `acquireInstanceLock`. */
  constructor(mint: symbol, path: string, nonce: string) {
    if (mint !== MINT) throw new AxisError("E_INVALID_ARGUMENT", "An instance lock can only be acquired with acquireInstanceLock");
    this.#path = path;
    this.#nonce = nonce;
  }

  /** True only for a genuine lock object (private-field brand check; cannot be forged by a literal). */
  static is(value: unknown): value is InstanceLock {
    return typeof value === "object" && value !== null && #held in value;
  }

  get path(): string {
    return this.#path;
  }

  get held(): boolean {
    return this.#held;
  }

  /**
   * Whether this lock guards the directory that holds `db`. An in-memory
   * database has no directory and no other process can share it, so any held
   * lock is accepted for it. Paths are compared after resolving symlinks.
   */
  guards(db: DatabaseSync): boolean {
    if (!this.#held) return false;
    try {
      // `location()` is null only for a true in-memory database. A file that merely has such a name (":memory:" in a
      // directory, "./:memory:") reports its real path here, so it takes the directory comparison below.
      const location = db.location();
      if (location === null) return true;
      return realpathSync(dirname(resolve(location))) === realpathSync(dirname(this.#path));
    } catch {
      return false; // a closed database, or a path that cannot be resolved, is not guarded
    }
  }

  release(): void {
    if (!this.#held) return;
    this.#held = false;
    try {
      if (readRecord(this.#path).record?.nonce === this.#nonce) unlinkSync(this.#path);
    } catch {
      // already gone
    }
  }
}

export interface LockOptions {
  readonly pid?: number;
  readonly now?: () => number;
  /** Override for tests: is this pid running? */
  readonly isAlive?: (pid: number) => boolean;
  /** Override for tests: the OS start time of a pid, or undefined if unknown. */
  readonly procStart?: (pid: number) => string | undefined;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
}

/** Process start time: /proc on Linux, `ps` elsewhere. Undefined when it cannot be read. */
export function processStartTime(pid: number): string | undefined {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[19]; // field 22, starttime in clock ticks since boot
    }
    if (process.platform === "win32") return undefined;
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
}

/**
 * Remove the stale lock file `path` (whose content was `raw` when judged stale),
 * serialised against other takers by an exclusive guard file. Without the guard
 * the compare and the unlink are two steps, and another process could finish its
 * own takeover between them and have its fresh lock deleted. A guard left by a
 * crashed taker is removed once it is older than the grace period.
 */
function takeOver(path: string, raw: string, now: () => number): void {
  const guard = `${path}.takeover`;
  let fd: number;
  try {
    fd = openSync(guard, "wx", 0o600);
  } catch {
    try {
      if (now() - statSync(guard).mtimeMs > UNPARSEABLE_GRACE_MS) unlinkSync(guard);
    } catch {
      // gone already
    }
    return; // another taker is at work; the caller retries
  }
  try {
    if (readFileSync(path, "utf8") === raw) unlinkSync(path);
  } catch {
    // already replaced or gone
  } finally {
    closeSync(fd);
    try {
      unlinkSync(guard);
    } catch {
      // gone
    }
  }
}

function readRecord(path: string): { raw: string; record: LockRecord | undefined } {
  const raw = readFileSync(path, "utf8");
  try {
    const parsed = JSON.parse(raw) as Partial<LockRecord>;
    if (typeof parsed.pid === "number" && typeof parsed.nonce === "string" && typeof parsed.startedAt === "number") {
      return { raw, record: { pid: parsed.pid, procStart: typeof parsed.procStart === "string" ? parsed.procStart : null, startedAt: parsed.startedAt, nonce: parsed.nonce } };
    }
  } catch {
    // fall through
  }
  return { raw, record: undefined };
}

/**
 * Take the exclusive single-instance lock for a database directory
 * (`axis.lock`, created atomically with `wx`). A lock is stale, and taken
 * over, when its pid is not running or the OS reports a different start time
 * for that pid than the one recorded (pid reuse). Otherwise acquisition fails
 * with E_CONFLICT. This guards against a second daemon on the same data by
 * accident; it is not a defence against a hostile process of the same user,
 * which can delete the file.
 */
export function acquireInstanceLock(dir: string, options: LockOptions = {}): InstanceLock {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? defaultIsAlive;
  const startOf = options.procStart ?? processStartTime;
  if (mkdirSync(dir, { recursive: true, mode: 0o700 }) === undefined) assertSafeDirectory(dir);
  const path = join(dir, LOCK_FILE);
  const record: LockRecord = { pid, procStart: startOf(pid) ?? null, startedAt: now(), nonce: randomBytes(16).toString("hex") };
  const body = JSON.stringify(record);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, body);
      } finally {
        closeSync(fd);
      }
      chmodSync(path, 0o600);
      return new InstanceLock(MINT, path, record.nonce);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new AxisError("E_UNAVAILABLE", "Could not create the instance lock");
      }
    }
    let seen: { raw: string; record: LockRecord | undefined };
    try {
      seen = readRecord(path);
    } catch {
      continue; // released between our attempts
    }
    let stale: boolean;
    if (seen.record) {
      const holder = seen.record;
      const alive = isAlive(holder.pid);
      const current = alive ? startOf(holder.pid) : undefined;
      stale = !alive || (holder.procStart !== null && current !== undefined && current !== holder.procStart);
    } else {
      stale = now() - statSync(path).mtimeMs > UNPARSEABLE_GRACE_MS;
    }
    if (!stale) {
      throw new AxisError("E_CONFLICT", "Another Axis daemon is using this database", seen.record ? { pid: seen.record.pid } : {});
    }
    // Compare-and-delete under a takeover guard, so no other taker can replace the file between our read and our unlink.
    takeOver(path, seen.raw, now);
  }
  throw new AxisError("E_CONFLICT", "Could not take the instance lock; another daemon is starting");
}
