// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
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

/** Proof that this process holds the database directory. `Journal.recover` requires one. */
export interface InstanceLock {
  readonly path: string;
  readonly held: boolean;
  release(): void;
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
  mkdirSync(dir, { recursive: true, mode: 0o700 });
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
      return makeLock(path, record.nonce);
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
    // Compare-and-delete: only remove the file we judged stale.
    try {
      if (readFileSync(path, "utf8") === seen.raw) unlinkSync(path);
    } catch {
      // someone else took it over; retry
    }
  }
  throw new AxisError("E_CONFLICT", "Could not take the instance lock; another daemon is starting");
}

function makeLock(path: string, nonce: string): InstanceLock {
  let held = true;
  return {
    path,
    get held() {
      return held;
    },
    release() {
      if (!held) return;
      held = false;
      try {
        if (readRecord(path).record?.nonce === nonce) unlinkSync(path);
      } catch {
        // already gone
      }
    },
  };
}
